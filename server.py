#!/usr/bin/env python3
import os
import sys
import re
import json
import subprocess
from http.server import SimpleHTTPRequestHandler, HTTPServer
import socketserver
import urllib.parse
import email
import email.policy
import requests
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor
import datetime

PORT = 8082
if getattr(sys, 'frozen', False):
    # Try PyInstaller's MEIPASS path first (standard on both Windows and macOS)
    meipass = getattr(sys, '_MEIPASS', None)
    if meipass and os.path.exists(os.path.join(meipass, "index.html")):
        PROJECT_DIR = meipass
    else:
        # Fallback to Contents/Resources inside macOS bundle
        exe_dir = os.path.dirname(sys.executable)
        resources_dir = os.path.abspath(os.path.join(exe_dir, "..", "Resources"))
        if os.path.exists(os.path.join(resources_dir, "index.html")):
            PROJECT_DIR = resources_dir
        else:
            PROJECT_DIR = exe_dir
else:
    PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))




import platform
def get_data_dir():
    if platform.system() == "Darwin":
        dir_path = os.path.expanduser("~/Library/Application Support/ManagebacDashboard")
    elif platform.system() == "Windows":
        dir_path = os.path.join(os.environ.get("APPDATA", ""), "ManagebacDashboard")
    else:
        dir_path = os.path.expanduser("~/.managebac_dashboard")
    os.makedirs(dir_path, exist_ok=True)
    return dir_path

DATA_DIR = get_data_dir()

# Migrate config/data files if they exist in PROJECT_DIR but not in DATA_DIR
for filename in ["config.json", "tasks_all.json", "cas_data.json", "subject_boundaries.json", "sync_status.json", "subject_grades.json"]:
    src = os.path.join(PROJECT_DIR, filename)
    dst = os.path.join(DATA_DIR, filename)
    if os.path.exists(src) and not os.path.exists(dst):
        try:
            import shutil
            shutil.copy2(src, dst)
        except Exception as e:
            print(f"Failed to migrate {filename}: {e}")

TASKS_FILE = os.path.join(DATA_DIR, "tasks_all.json")
STATUS_FILE = os.path.join(DATA_DIR, "sync_status.json")
CAS_DATA_FILE = os.path.join(DATA_DIR, "cas_data.json")
BOUNDARIES_FILE = os.path.join(DATA_DIR, "subject_boundaries.json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
TRIAL_INFO_FILE = os.path.join(DATA_DIR, ".trial_info")
GRADES_FILE = os.path.join(DATA_DIR, "subject_grades.json")

# Pre-defined credentials (empty by default)
MB_USER = ""
MB_PASS = ""
BASE_URL = "https://sdgj.managebac.cn"

def check_trial_status():
    """
    Returns (is_expired, remaining_days)
    """
    try:
        now = datetime.datetime.now()
        first_launch = None
        last_seen = None
        is_unlocked = False
        
        if os.path.exists(TRIAL_INFO_FILE):
            try:
                with open(TRIAL_INFO_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    first_launch_str = data.get("first_launch")
                    last_seen_str = data.get("last_seen")
                    is_unlocked = data.get("unlocked", False)
                    if first_launch_str:
                        first_launch = datetime.datetime.fromisoformat(first_launch_str)
                    if last_seen_str:
                        last_seen = datetime.datetime.fromisoformat(last_seen_str)
            except Exception as e:
                print(f"Error reading trial info: {e}")
        
        if is_unlocked:
            return False, 999.0
            
        # Initialize if not present
        if not first_launch:
            first_launch = now
            last_seen = now
            try:
                with open(TRIAL_INFO_FILE, "w", encoding="utf-8") as f:
                    json.dump({
                        "first_launch": first_launch.isoformat(),
                        "last_seen": last_seen.isoformat(),
                        "unlocked": False
                    }, f)
            except Exception as e:
                print(f"Error writing trial info: {e}")
                
        # Clock tamper detection
        if last_seen and now < last_seen - datetime.timedelta(minutes=5):
            print("System clock tamper detected! Locking application.")
            return True, 0.0
            
        # Update last_seen
        if not last_seen or now > last_seen:
            last_seen = now
            try:
                with open(TRIAL_INFO_FILE, "w", encoding="utf-8") as f:
                    json.dump({
                        "first_launch": first_launch.isoformat(),
                        "last_seen": last_seen.isoformat(),
                        "unlocked": False
                    }, f)
            except:
                pass
                
        delta = now - first_launch
        days_passed = delta.days + (delta.seconds / 86400.0)
        remaining_days = max(0.0, 7.0 - days_passed)
        
        if days_passed > 7.0:
            return True, 0.0
        return False, remaining_days
    except Exception as e:
        print(f"Error checking trial: {e}")
        return False, 7.0

def load_credentials():
    global MB_USER, MB_PASS, BASE_URL
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                config = json.load(f)
                MB_USER = config.get("email", MB_USER)
                MB_PASS = config.get("password", MB_PASS)
                subdomain = config.get("school_subdomain", config.get("subdomain", "sdgj.managebac.cn"))
                BASE_URL = f"https://{subdomain}"
        except Exception as e:
            print(f"Error loading credentials from config.json: {e}")

load_credentials()

mb_session = requests.Session()
mb_session.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
})
mb_logged_in = False

class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # Serve from the project directory
        super().__init__(*args, directory=PROJECT_DIR, **kwargs)

    def end_headers(self):
        # Disable caching globally for all static assets and APIs to prevent WKWebView from loading stale cached code
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def serve_trial_expired(self):
        html = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Trial Expired - ManageBac Student Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-gradient: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #020617 100%);
            --glass-bg: rgba(30, 41, 59, 0.45);
            --glass-border: rgba(255, 255, 255, 0.08);
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --accent-purple: #8b5cf6;
            --accent-pink: #ec4899;
        }
        
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background: var(--bg-gradient);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            position: relative;
        }
        
        /* Decorative Background Orbs */
        .orb {
            position: absolute;
            width: 400px;
            height: 400px;
            border-radius: 50%;
            filter: blur(120px);
            opacity: 0.15;
            z-index: 1;
        }
        .orb-1 {
            background: var(--accent-purple);
            top: -100px;
            left: -100px;
        }
        .orb-2 {
            background: var(--accent-pink);
            bottom: -100px;
            right: -100px;
        }
        
        .container {
            z-index: 2;
            width: 100%;
            max-width: 500px;
            padding: 40px;
            border-radius: 24px;
            background: var(--glass-bg);
            border: 1px solid var(--glass-border);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
            text-align: center;
            animation: fadeIn 0.8s ease-out;
        }
        
        .icon-wrapper {
            width: 80px;
            height: 80px;
            background: rgba(239, 68, 68, 0.15);
            border: 1px solid rgba(239, 68, 68, 0.3);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
            color: #ef4444;
        }
        
        h1 {
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 16px;
            background: linear-gradient(135deg, #f8fafc 0%, #cbd5e1 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        p {
            color: var(--text-secondary);
            font-size: 15px;
            line-height: 1.6;
            margin-bottom: 24px;
        }
        
        .divider {
            height: 1px;
            background: var(--glass-border);
            margin: 24px 0;
        }
        
        .info-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 12px;
            font-size: 14px;
        }
        
        .info-label {
            color: var(--text-secondary);
        }
        
        .info-value {
            font-weight: 600;
            color: var(--text-primary);
        }
        
        .passcode-field {
            width: 100%;
            padding: 14px;
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--glass-border);
            color: white;
            font-size: 15px;
            text-align: center;
            margin-top: 16px;
            box-sizing: border-box;
            outline: none;
            transition: border-color 0.2s ease;
        }
        
        .passcode-field:focus {
            border-color: var(--accent-purple);
        }
        
        .error-msg {
            color: #ef4444;
            font-size: 13px;
            margin-top: 12px;
            display: none;
        }
        
        .success-msg {
            color: #10b981;
            font-size: 13px;
            margin-top: 12px;
            display: none;
        }
        
        .contact-btn {
            display: inline-block;
            width: 100%;
            padding: 14px;
            border-radius: 12px;
            background: linear-gradient(135deg, var(--accent-purple) 0%, #7c3aed 100%);
            border: none;
            color: white;
            font-weight: 600;
            font-size: 15px;
            cursor: pointer;
            text-decoration: none;
            transition: all 0.2s ease;
            box-shadow: 0 4px 15px rgba(139, 92, 246, 0.3);
            margin-top: 16px;
        }
        
        .contact-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(139, 92, 246, 0.4);
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
    </style>
    <script>
        function unlockApp() {
            const val = document.getElementById('passcode-input').value;
            const err = document.getElementById('error-msg');
            const succ = document.getElementById('success-msg');
            
            err.style.display = 'none';
            succ.style.display = 'none';
            
            fetch('/api/trial/unlock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ passcode: val })
            })
            .then(res => res.json().then(data => ({ status: res.status, data })))
            .then(({ status, data }) => {
                if (status === 200) {
                    succ.innerText = data.message || "App successfully unlocked!";
                    succ.style.display = 'block';
                    setTimeout(() => {
                        window.location.reload();
                    }, 1500);
                } else {
                    err.innerText = data.message || "Invalid passcode.";
                    err.style.display = 'block';
                }
            })
            .catch(e => {
                err.innerText = "Error connecting to service: " + e;
                err.style.display = 'block';
            });
        }
    </script>
</head>
<body>
    <div class="orb orb-1"></div>
    <div class="orb orb-2"></div>
    
    <div class="container">
        <div class="icon-wrapper">
            <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
        </div>
        <h1>Trial Period Expired</h1>
        <p>Your 7-day trial of the ManageBac Student Dashboard has completed. Enter the passcode to unlock the full application.</p>
        
        <input type="password" id="passcode-input" placeholder="Enter passcode" class="passcode-field">
        <div id="error-msg" class="error-msg"></div>
        <div id="success-msg" class="success-msg"></div>
        
        <button onclick="unlockApp()" class="contact-btn">Unlock Application</button>
        
        <div class="divider"></div>
        
        <div class="info-row">
            <span class="info-label">Trial Duration</span>
            <span class="info-value">7 Days</span>
        </div>
        <div class="info-row">
            <span class="info-label">Status</span>
            <span class="info-value" style="color: #ef4444;">Expired</span>
        </div>
    </div>
</body>
</html>
"""
        response_bytes = html.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def do_GET(self):
        is_expired, remaining_days = check_trial_status()
        if is_expired:
            if self.path.startswith('/api/'):
                res = {"error": "Trial expired", "expired": True}
                response_bytes = json.dumps(res).encode('utf-8')
                self.send_response(403)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(response_bytes)))
                self.end_headers()
                self.wfile.write(response_bytes)
            else:
                self.serve_trial_expired()
            return

        if self.path == '/api/tasks':
            self.handle_get_tasks()
        elif self.path == '/api/sync-status':
            self.handle_get_status()
        elif self.path.startswith('/api/calendar-events'):
            self.handle_get_calendar_events()
        elif self.path == '/api/cas/data':
            self.handle_get_cas_data()
        elif self.path == '/api/auth/status':
            self.handle_auth_status()
        elif self.path == '/api/subject-boundaries':
            self.handle_get_boundaries()
        elif self.path == '/api/subject-grades':
            self.handle_get_subject_grades()
        else:
            # Fallback to serving static files
            super().do_GET()

    def do_POST(self):
        # Allow unlock endpoint to bypass expiration check
        if self.path == '/api/trial/unlock':
            self.handle_trial_unlock()
            return

        is_expired, remaining_days = check_trial_status()
        if is_expired:
            res = {"error": "Trial expired", "expired": True}
            response_bytes = json.dumps(res).encode('utf-8')
            self.send_response(403)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response_bytes)))
            self.end_headers()
            self.wfile.write(response_bytes)
            return

        if self.path == '/api/sync':
            self.handle_trigger_sync()
        elif self.path == '/api/cas/sync':
            self.handle_cas_sync()
        elif self.path == '/api/cas/upload':
            self.handle_cas_upload()
        elif self.path == '/api/auth/login':
            self.handle_auth_login()
        elif self.path == '/api/auth/logout':
            self.handle_auth_logout()
        else:
            self.send_error(404, "Endpoint not found")

    def handle_trial_unlock(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8')
            params = json.loads(post_data)
            passcode = params.get("passcode", "")
            
            if passcode == "ManagebacPremium2026":
                # Unlock
                first_launch_str = None
                last_seen_str = None
                if os.path.exists(TRIAL_INFO_FILE):
                    try:
                        with open(TRIAL_INFO_FILE, "r", encoding="utf-8") as f:
                            data = json.load(f)
                            first_launch_str = data.get("first_launch")
                            last_seen_str = data.get("last_seen")
                    except:
                        pass
                
                # Write unlocked state
                with open(TRIAL_INFO_FILE, "w", encoding="utf-8") as f:
                    json.dump({
                        "first_launch": first_launch_str or datetime.datetime.now().isoformat(),
                        "last_seen": last_seen_str or datetime.datetime.now().isoformat(),
                        "unlocked": True
                    }, f)
                
                res = {"success": True, "message": "App successfully unlocked!"}
                self.send_response(200)
            else:
                res = {"success": False, "message": "Invalid passcode. Please contact developer."}
                self.send_response(400)
                
        except Exception as e:
            res = {"success": False, "message": f"Error: {str(e)}"}
            self.send_response(500)
            
        response_bytes = json.dumps(res).encode('utf-8')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def handle_get_tasks(self):
        tasks = []
        if os.path.exists(TASKS_FILE):
            try:
                with open(TASKS_FILE, "r", encoding="utf-8") as f:
                    tasks = json.load(f)
            except Exception as e:
                print(f"Error loading tasks JSON: {e}")
                
        response_bytes = json.dumps(tasks, ensure_ascii=False).encode('utf-8')
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def handle_auth_status(self):
        config_exists = os.path.exists(CONFIG_FILE)
        remembered = False
        email_val = ""
        subdomain_val = "sdgj.managebac.cn"
        
        if config_exists:
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    config = json.load(f)
                    email_val = config.get("email", "")
                    subdomain_val = config.get("school_subdomain", config.get("subdomain", "sdgj.managebac.cn"))
                    remembered = config.get("remember", True)
            except Exception as e:
                print(f"Error reading config: {e}")
                
        res = {
            "credentials_exist": config_exists,
            "remembered": remembered,
            "email": email_val,
            "subdomain": subdomain_val
        }
        response_bytes = json.dumps(res).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def handle_auth_login(self):
        global mb_session, mb_logged_in, MB_USER, MB_PASS, BASE_URL
        body = {}
        try:
            content_length = int(self.headers.get('content-length', 0))
            body_bytes = self.rfile.read(content_length)
            body = json.loads(body_bytes.decode('utf-8'))
        except Exception as e:
            print(f"Error reading login body: {e}")
            
        email_val = body.get("email")
        password_val = body.get("password")
        subdomain_val = body.get("subdomain", "sdgj.managebac.cn")
        remember_val = body.get("remember", True)
        
        if not email_val or not password_val:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Email and password are required"}).encode('utf-8'))
            return
            
        # Verify credentials against ManageBac
        test_session = requests.Session()
        test_session.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        })
        
        test_base_url = f"https://{subdomain_val}"
        success = False
        error_msg = "Failed to login to ManageBac. Check credentials."
        
        try:
            r = test_session.get(f"{test_base_url}/login", timeout=15)
            soup = BeautifulSoup(r.text, 'html.parser')
            csrf_token = extract_csrf_token(soup)
            if csrf_token:
                payload = {
                    'authenticity_token': csrf_token,
                    'login': email_val,
                    'password': password_val,
                    'remember_me': '1',
                    'commit': 'Sign in'
                }
                r_post = test_session.post(f"{test_base_url}/sessions", data=payload, headers={'Referer': f"{test_base_url}/login"}, allow_redirects=True, timeout=15)
                r_home = test_session.get(f"{test_base_url}/student/home", allow_redirects=True, timeout=15)
                if r_home.status_code == 200 and "student" in r_home.url:
                    success = True
                else:
                    error_msg = "Invalid email or password. Please verify your credentials."
            else:
                error_msg = "Could not connect to ManageBac. CSRF token missing."
        except Exception as e:
            print(f"Login attempt error: {e}")
            error_msg = f"Connection error: {str(e)}"
            
        if success:
            # Save to config.json
            try:
                existing_config = {}
                if os.path.exists(CONFIG_FILE):
                    try:
                        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                            existing_config = json.load(f)
                    except Exception:
                        pass
                config_data = {
                    "email": email_val,
                    "password": password_val,
                    "school_subdomain": subdomain_val,
                    "remember": remember_val,
                    "enable_system_reminders": existing_config.get("enable_system_reminders", False),
                    "enable_system_calendar": existing_config.get("enable_system_calendar", False)
                }
                with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                    json.dump(config_data, f, indent=2)
            except Exception as e:
                print(f"Error writing config: {e}")
                
            # Update global state
            MB_USER = email_val
            MB_PASS = password_val
            BASE_URL = test_base_url
            mb_session = test_session
            mb_logged_in = True
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True}).encode('utf-8'))
        else:
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": False, "error": error_msg}).encode('utf-8'))

    def handle_auth_logout(self):
        global mb_session, mb_logged_in, MB_USER, MB_PASS
        # Clear remember flag or delete credentials
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    config = json.load(f)
                config["remember"] = False
                config["password"] = ""
                with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                    json.dump(config, f, indent=2)
            except Exception as e:
                print(f"Error resetting config: {e}")
                
        # Clear cached user data files on logout to prevent cross-account data leakage
        for filepath in [TASKS_FILE, CAS_DATA_FILE, BOUNDARIES_FILE, STATUS_FILE, GRADES_FILE]:
            if os.path.exists(filepath):
                try:
                    os.remove(filepath)
                except Exception as e:
                    print(f"Error deleting cached file {filepath} on logout: {e}")
                    
        # Re-initialize session
        mb_session = requests.Session()
        mb_session.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        })
        mb_logged_in = False
        MB_USER = ""
        MB_PASS = ""
        
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"success": True}).encode('utf-8'))

    def handle_get_status(self):
        status = {
            "status": "idle",
            "message": "System idle",
            "progress": 0
        }
        if os.path.exists(STATUS_FILE):
            try:
                with open(STATUS_FILE, "r", encoding="utf-8") as f:
                    status = json.load(f)
            except Exception as e:
                print(f"Error loading status JSON: {e}")
                
        response_bytes = json.dumps(status, ensure_ascii=False).encode('utf-8')
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def handle_get_cas_data(self):
        data = {"experiences": [], "reflections": [], "last_sync": None}
        if os.path.exists(CAS_DATA_FILE):
            try:
                with open(CAS_DATA_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception as e:
                print(f"Error loading CAS data JSON: {e}")
                
        response_bytes = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def handle_cas_sync(self):
        global mb_logged_in
        load_credentials()
        print("Triggering CAS Sync...")
        
        # Check login or authenticate
        logged_in = False
        try:
            if mb_logged_in:
                r = mb_session.get(f"{BASE_URL}/student/home", allow_redirects=False)
                if r.status_code == 200:
                    logged_in = True
            if not logged_in:
                r = mb_session.get(f"{BASE_URL}/login")
                soup = BeautifulSoup(r.text, 'html.parser')
                csrf_token = extract_csrf_token(soup)
                if csrf_token:
                    payload = {
                        'authenticity_token': csrf_token,
                        'login': MB_USER,
                        'password': MB_PASS,
                        'remember_me': '1',
                        'commit': 'Sign in'
                    }
                    r_post = mb_session.post(f"{BASE_URL}/sessions", data=payload, headers={'Referer': f"{BASE_URL}/login"}, allow_redirects=True)
                    r_home = mb_session.get(f"{BASE_URL}/student/home", allow_redirects=True)
                    if r_home.status_code == 200 and "student" in r_home.url:
                        mb_logged_in = True
                        logged_in = True
        except Exception as e:
            print(f"Error authenticating: {e}")
            
        if not logged_in:
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Failed to log in to ManageBac. Check credentials."}).encode('utf-8'))
            return
            
        try:
            # 1. Scrape experiences
            print("Syncing CAS experiences...")
            r = mb_session.get(f"{BASE_URL}/student/ib/activity/cas")
            soup = BeautifulSoup(r.text, 'html.parser')
            experience_links = soup.find_all('a', href=lambda h: h and re.match(r'^/student/ib/activity/cas/\d+$', h))
            
            experiences = {}
            for link in experience_links:
                href = link['href']
                name = link.get_text(strip=True)
                if not name:
                    continue
                card = None
                curr = link
                for _ in range(6):
                    curr = curr.parent
                    if not curr: break
                    classes = curr.get('class', [])
                    if any('card' in c or 'item' in c or 'panel' in c or 'd-flex' in c for c in classes):
                        card = curr
                        break
                hours = 0
                categories = []
                status = "Unknown"
                if card:
                    # Find all hour-type-hint spans
                    spans = card.find_all(class_=re.compile(r'hour-type-hint-[cas]', re.I))
                    for span in spans:
                        cls = span.get('class', [])
                        for c in cls:
                            if 'hour-type-hint-' in c:
                                cat = c.split('-')[-1].upper()
                                if cat in ['C', 'A', 'S']:
                                    categories.append(cat)
                        title = span.get('data-bs-title', '')
                        hm = re.search(r'(\d+)\s+hours?', title, re.I)
                        if hm:
                            hours += int(hm.group(1))
                    # Fallback for hours in text
                    if hours == 0:
                        card_text = card.get_text(" ")
                        hours_match = re.search(r'(\d+)\s+hours?', card_text, re.I)
                        if hours_match:
                            hours = int(hours_match.group(1))
                    # Status from badge span
                    status_span = card.find('span', class_=re.compile(r'color-box', re.I))
                    if status_span:
                        status = status_span.get_text(strip=True)
                    elif 'Ongoing' in card.get_text():
                        status = 'Ongoing'
                    elif 'Completed' in card.get_text():
                        status = 'Completed'
                categories = list(set(categories))
                exp_id = href.split('/')[-1]
                experiences[href] = {
                    "id": exp_id,
                    "name": name,
                    "hours": hours,
                    "categories": categories,
                    "status": status,
                    "url": f"{BASE_URL}{href}"
                }
            
            experiences_list = list(experiences.values())
            
            # 2. Scrape reflections in parallel
            print(f"Syncing reflections for {len(experiences_list)} experiences in parallel...")
            all_reflections = []
            
            def fetch_ref_worker(exp):
                reflections_url = f"{BASE_URL}/student/ib/activity/cas/{exp['id']}/reflections"
                try:
                    r_ref = mb_session.get(reflections_url)
                    soup_ref = BeautifulSoup(r_ref.text, 'html.parser')
                    evidence_items = soup_ref.find_all(class_='evidence')
                    items = []
                    for ev in evidence_items:
                        ev_type = "Journal"
                        classes = ev.get('class', [])
                        if 'journal-evidence' in classes: ev_type = "Journal"
                        elif 'file-evidence' in classes: ev_type = "File"
                        elif 'album-evidence' in classes: ev_type = "Photos"
                        elif 'evidence-video' in classes: ev_type = "Video"
                        elif 'evidence-website' in classes: ev_type = "Website"
                        
                        date_text = "Unknown Date"
                        for s in ev.stripped_strings:
                            match = re.search(r'(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+[A-Za-z]{3}\s+\d{1,2},\s+\d{4}', s)
                            if match:
                                date_text = match.group(0)
                                break
                                
                        outcomes = []
                        outcome_short_names = ["Strength & Growth", "Challenge & Skills", "Initiative & Planning", "Commitment & Perseverance", "Collaborative Skills", "Ethics of Choices & Actions", "Global Engagement"]
                        all_text = ev.get_text(" ")
                        for short in outcome_short_names:
                            if short in all_text:
                                outcomes.append(short)
                        body_el = ev.find(class_='body')
                        body_text = body_el.get_text(strip=True) if body_el else ""
                        attachments = []
                        seen_att_urls = set()
                        links = ev.find_all('a', href=True)
                        for l in links:
                            href = l['href']
                            text = l.get_text(strip=True)
                            if "amazonaws.com.cn" in href or "/uploads/" in href:
                                # Deduplicate by base URL (strip query params for comparison)
                                base_url = href.split('?')[0]
                                if base_url not in seen_att_urls:
                                    seen_att_urls.add(base_url)
                                    attachments.append({
                                        "name": text or href.split('/')[-1].split('?')[0],
                                        "url": href if href.startswith("http") else f"{BASE_URL}{href}"
                                    })
                        img_urls = []
                        for img in ev.find_all('img'):
                            src = img.get('src')
                            if src and "sebo" not in src and "avatar" not in src and "logo" not in src:
                                img_urls.append(src if src.startswith("http") else f"{BASE_URL}{src}")
                                
                        # Support for div.photo in album-evidence
                        for photo in ev.find_all(class_='photo'):
                            f_url = photo.get('data-full-url') or photo.get('data-url')
                            if f_url:
                                img_urls.append(f_url if f_url.startswith("http") else f"{BASE_URL}{f_url}")
                            if not body_text:
                                p_title = photo.get('data-bs-title') or photo.get('title')
                                if p_title:
                                    body_text = p_title
                                    
                        items.append({
                            "type": ev_type,
                            "date": date_text,
                            "outcomes": list(set(outcomes)),
                            "body": body_text,
                            "attachments": attachments,
                            "images": img_urls,
                            "experience_name": exp['name'],
                            "experience_id": exp['id'],
                            "experience_categories": exp['categories']
                        })
                    return items
                except Exception as e:
                    print(f"Error fetching reflections for {exp['name']}: {e}")
                    return []

            with ThreadPoolExecutor(max_workers=5) as executor:
                results = executor.map(fetch_ref_worker, experiences_list)
                for res in results:
                    all_reflections.extend(res)
            
            # Save to JSON cache file to save system resources!
            cas_data = {
                "experiences": experiences_list,
                "reflections": all_reflections,
                "last_sync": datetime.datetime.now().isoformat()
            }
            with open(CAS_DATA_FILE, "w", encoding="utf-8") as f:
                json.dump(cas_data, f, ensure_ascii=False)
                
            response_bytes = json.dumps(cas_data, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(response_bytes)))
            self.end_headers()
            self.wfile.write(response_bytes)
            
        except Exception as e:
            print(f"Error running CAS sync: {e}")
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))

    def handle_cas_upload(self):
        # Authenticate first
        global mb_logged_in
        load_credentials()
        logged_in = False
        try:
            if mb_logged_in:
                r = mb_session.get(f"{BASE_URL}/student/home", allow_redirects=False)
                if r.status_code == 200:
                    logged_in = True
            if not logged_in:
                r = mb_session.get(f"{BASE_URL}/login")
                soup = BeautifulSoup(r.text, 'html.parser')
                csrf_token = extract_csrf_token(soup)
                if csrf_token:
                    payload = {
                        'authenticity_token': csrf_token,
                        'login': MB_USER,
                        'password': MB_PASS,
                        'remember_me': '1',
                        'commit': 'Sign in'
                    }
                    r_post = mb_session.post(f"{BASE_URL}/sessions", data=payload, headers={'Referer': f"{BASE_URL}/login"}, allow_redirects=True)
                    r_home = mb_session.get(f"{BASE_URL}/student/home", allow_redirects=True)
                    if r_home.status_code == 200 and "student" in r_home.url:
                        mb_logged_in = True
                        logged_in = True
        except Exception as e:
            print(f"Error check login: {e}")
            
        if not logged_in:
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Unauthorized / Login failed"}).encode('utf-8'))
            return
            
        try:
            content_type = self.headers.get('content-type')
            content_length = int(self.headers.get('content-length', 0))
            body_bytes = self.rfile.read(content_length)
            
            headers_bytes = f"Content-Type: {content_type}\r\n\r\n".encode('utf-8')
            parsed_msg = email.message_from_bytes(headers_bytes + body_bytes, policy=email.policy.default)
            
            form_fields = {}
            files_to_upload = []
            
            if parsed_msg.is_multipart():
                for part in parsed_msg.iter_parts():
                    name = part.get_param('name', header='content-disposition')
                    filename = part.get_filename()
                    if filename:
                        file_data = part.get_payload(decode=True)
                        if file_data and len(file_data) > 0:
                            files_to_upload.append({
                                "name": name,
                                "filename": filename,
                                "data": file_data,
                                "content_type": part.get_content_type()
                            })
                    else:
                        val = part.get_payload(decode=True).decode('utf-8')
                        if name in form_fields:
                            if isinstance(form_fields[name], list): form_fields[name].append(val)
                            else: form_fields[name] = [form_fields[name], val]
                        else:
                            form_fields[name] = val
                            
            exp_id = form_fields.get("experience_id")
            evidence_type = form_fields.get("type", "JournalEvidence")
            body_text = form_fields.get("body", "")
            evidence_url = form_fields.get("url", "")
            outcomes = form_fields.get("learning_outcome_ids[]", [])
            if not isinstance(outcomes, list):
                outcomes = [outcomes]
            outcomes = [o for o in outcomes if o]
            
            print(f"Uploading CAS item ({evidence_type}) to experience {exp_id}...")
            
            # GET form page for CSRF token
            new_ref_url = f"{BASE_URL}/student/ib/activity/cas/{exp_id}/reflections/new"
            r_new = mb_session.get(new_ref_url)
            soup = BeautifulSoup(r_new.text, 'html.parser')
            csrf_token = extract_csrf_token(soup)
            if not csrf_token:
                raise ValueError("Failed to obtain CSRF authenticity token.")
                
            post_url = f"{BASE_URL}/student/ib/activity/cas/{exp_id}/reflections"
            payload = {
                'authenticity_token': csrf_token,
                'type': evidence_type,
                'evidence[body]': body_text,
                'commit': 'Add Entry'
            }
            if evidence_type in ["YoutubeEvidence", "WebsiteEvidence"]:
                payload['evidence[url]'] = evidence_url
                
            data_list = list(payload.items())
            for o_id in outcomes:
                data_list.append(('evidence[learning_outcome_ids][]', o_id))
                
            files_payload = {}
            if evidence_type == "FileEvidence" and files_to_upload:
                f = files_to_upload[0]
                files_payload['evidence[asset_attributes][file]'] = (f['filename'], f['data'], f['content_type'])
            elif evidence_type == "AlbumEvidence" and files_to_upload:
                f = files_to_upload[0]
                files_payload['evidence[photos_attributes][0][file]'] = (f['filename'], f['data'], f['content_type'])
                data_list.append(('evidence[photos_attributes][0][caption]', f['filename']))
                data_list.append(('evidence[photos_attributes][0][created_at]', ''))
            
            # ManageBac form uses data-remote="true" (Rails UJS AJAX).
            # We must send XHR headers so the server returns JS, not a redirect.
            # We also disable redirects: a 302 redirect to the reflections page means success.
            upload_headers = {
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01',
                'Referer': new_ref_url,
                'X-CSRF-Token': csrf_token,
            }
            
            r_upload = mb_session.post(post_url, data=data_list, files=files_payload,
                                       headers=upload_headers, allow_redirects=False)
            
            print(f"  Upload response: status={r_upload.status_code}, content-type={r_upload.headers.get('content-type', 'N/A')}, body[:200]={r_upload.text[:200]}")
            
            # Success indicators:
            # 1) 302 redirect (standard Rails create -> redirect)
            # 2) 200 with JS response (Rails UJS success callback)
            # 3) Response doesn't contain error indicators
            upload_ok = False
            if r_upload.status_code == 302:
                # Standard redirect after successful creation
                upload_ok = True
            elif r_upload.status_code == 200:
                resp_text = r_upload.text.lower()
                # Check for error indicators in the JS response
                if 'error' not in resp_text and 'alert(' not in resp_text and 'invalid' not in resp_text:
                    upload_ok = True
                # Also check if response contains success indicators
                if 'location.reload' in resp_text or 'window.location' in resp_text or 'flash' in resp_text:
                    upload_ok = True
            
            if upload_ok:
                print(f"  Upload SUCCESS for experience {exp_id}")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True}).encode('utf-8'))
            else:
                print(f"  Upload FAILED for experience {exp_id}: status={r_upload.status_code}")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"ManageBac upload failed (HTTP {r_upload.status_code})."}).encode('utf-8'))
        except Exception as e:
            print(f"Error uploading item: {e}")
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))

    def handle_get_calendar_events(self):
        events = []
        enable_system_calendar = False
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    config = json.load(f)
                    enable_system_calendar = config.get("enable_system_calendar", False)
            except Exception as e:
                print(f"Error reading calendar config: {e}")

        if enable_system_calendar:
            applescript = r'''
            set startLimit to (current date) - (14 * days)
            set endLimit to (current date) + (30 * days)

            tell application "Calendar"
                set results to ""
                set allCalendars to calendars
                repeat with aCal in allCalendars
                    set calName to name of aCal
                    tell aCal
                        set theEvents to (every event whose (start date is greater than or equal to startLimit) and (start date is less than or equal to endLimit))
                        repeat with anEvent in theEvents
                            set evTitle to summary of anEvent
                            set evStart to start date of anEvent
                            set evEnd to end date of anEvent
                            set evLoc to location of anEvent
                            if evLoc is missing value then set evLoc to ""
                            set evDesc to description of anEvent
                            if evDesc is missing value then set evDesc to ""
                            set isAllDay to allday event of anEvent
                            
                            -- Format date to string
                            set startStr to (year of evStart as text) & "-" & (month of evStart as integer as text) & "-" & (day of evStart as text) & " " & time string of evStart
                            set endStr to (year of evEnd as text) & "-" & (month of evEnd as integer as text) & "-" & (day of evEnd as text) & " " & time string of evEnd
                            
                            set results to results & calName & "||" & evTitle & "||" & startStr & "||" & endStr & "||" & evLoc & "||" & evDesc & "||" & (isAllDay as text) & "\n"
                        end repeat
                    end tell
                end repeat
                return results
            end tell
            '''
            try:
                res = subprocess.run(["osascript"], input=applescript, capture_output=True, text=True, encoding="utf-8", timeout=15)
                if res.returncode == 0:
                    lines = res.stdout.strip().split("\n")
                    for line in lines:
                        if "||" in line:
                            parts = line.split("||")
                            if len(parts) >= 7:
                                cal_name = parts[0]
                                title = parts[1]
                                start_raw = parts[2]
                                end_raw = parts[3]
                                loc = parts[4]
                                desc = parts[5]
                                is_all_day = parts[6].strip().lower() == "true"
                                
                                start_iso = self.parse_applescript_date(start_raw)
                                end_iso = self.parse_applescript_date(end_raw)
                                
                                events.append({
                                    "calendar": cal_name,
                                    "title": title,
                                    "start": start_iso,
                                    "end": end_iso,
                                    "location": loc,
                                    "description": desc,
                                    "is_all_day": is_all_day
                                })
                else:
                    print(f"AppleScript error (code {res.returncode}): {res.stderr}")
            except Exception as e:
                print(f"Error fetching calendar events: {e}")
        else:
            print("System calendar integration is disabled. Returning empty list.")

        response_bytes = json.dumps(events, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def parse_applescript_date(self, date_str):
        parts = date_str.strip().split()
        if not parts:
            return ""
        date_part = parts[0]
        time_part = parts[1] if len(parts) > 1 else "00:00:00"
        ampm = parts[2].upper() if len(parts) > 2 else ""
        
        try:
            y, m, d = map(int, date_part.split("-"))
            h, min_val, s = map(int, time_part.split(":"))
            if ampm == "PM" and h < 12:
                h += 12
            elif ampm == "AM" and h == 12:
                h = 0
            return f"{y:04d}-{m:02d}-{d:02d}T{h:02d}:{min_val:02d}:{s:02d}"
        except Exception as e:
            print(f"Error parsing date string '{date_str}': {e}")
            return ""


    def handle_trigger_sync(self):
        # Check if already syncing
        current_status = "idle"
        if os.path.exists(STATUS_FILE):
            try:
                with open(STATUS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    current_status = data.get("status", "idle")
            except:
                pass
                
        if current_status == "syncing":
            res = {"status": "syncing", "message": "A synchronization is already running."}
        else:
            # Trigger scraper as subprocess
            try:
                # Start process in background
                if getattr(sys, 'frozen', False):
                    subprocess.Popen([sys.executable, "--run-scraper"])
                else:
                    scraper_path = os.path.join(PROJECT_DIR, "scraper.py")
                    subprocess.Popen([sys.executable, scraper_path])
                res = {"status": "syncing", "message": "Synchronization started."}
                
                # Write initial syncing status
                status_init = {
                    "status": "syncing",
                    "message": "Initializing crawler...",
                    "progress": 0
                }
                # Preserve last_sync if available
                if os.path.exists(STATUS_FILE):
                    try:
                        with open(STATUS_FILE, "r", encoding="utf-8") as f:
                            old_data = json.load(f)
                            if "last_sync" in old_data:
                                status_init["last_sync"] = old_data["last_sync"]
                    except:
                        pass
                with open(STATUS_FILE, "w", encoding="utf-8") as f:
                    json.dump(status_init, f)
            except Exception as e:
                print(f"Error launching scraper: {e}")
                res = {"status": "error", "message": f"Could not launch crawler: {e}"}
                
        response_bytes = json.dumps(res, ensure_ascii=False).encode('utf-8')
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def handle_get_boundaries(self):
        boundaries = {}
        if os.path.exists(BOUNDARIES_FILE):
            try:
                with open(BOUNDARIES_FILE, "r", encoding="utf-8") as f:
                    boundaries = json.load(f)
            except Exception as e:
                print(f"Error loading boundaries: {e}")
        else:
            boundaries = extract_subject_boundaries()
            
        response_bytes = json.dumps(boundaries, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def handle_get_subject_grades(self):
        grades = {}
        if os.path.exists(GRADES_FILE):
            try:
                with open(GRADES_FILE, "r", encoding="utf-8") as f:
                    grades = json.load(f)
            except Exception as e:
                print(f"Error loading subject grades: {e}")
        response_bytes = json.dumps(grades, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

def extract_subject_boundaries():
    print("Extracting subject boundaries from ManageBac...")
    try:
        if not os.path.exists(CONFIG_FILE) or not os.path.exists(TASKS_FILE):
            return {}
        
        with open(CONFIG_FILE, "r") as f:
            config = json.load(f)
            email = config.get("email")
            password = config.get("password")
            subdomain = config.get("school_subdomain", "sdgj.managebac.cn")
            
        with open(TASKS_FILE, "r") as f:
            tasks = json.load(f)
            
        subject_tasks = {}
        for t in tasks:
            sub = t.get("subject")
            url = t.get("url")
            status = t.get("status")
            if sub and url and status == "Assessed":
                if sub not in subject_tasks:
                    subject_tasks[sub] = url
                    
        session = requests.Session()
        session.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        })
        
        r = session.get(f"https://{subdomain}/login")
        soup = BeautifulSoup(r.text, 'html.parser')
        csrf_token = extract_csrf_token(soup)
        if not csrf_token:
            return {}
            
        payload = {
            'authenticity_token': csrf_token,
            'login': email,
            'password': password,
            'remember_me': '1',
            'commit': 'Sign in'
        }
        session.post(f"https://{subdomain}/sessions", data=payload, allow_redirects=True)
        
        boundaries = {}
        for sub, url in subject_tasks.items():
            res = session.get(url)
            if res.status_code != 200:
                continue
            soup_task = BeautifulSoup(res.text, 'html.parser')
            text = soup_task.get_text(" ", strip=True)
            scale_match = re.search(r'(?:Task Grade Scale|Grade Scale|Score\s+Mark)\s*(.*?)(?:Author|Comments|Dropbox|Student|Add Entry|$)', text, re.I | re.S)
            
            sub_boundaries = {"6": 70.0, "7": 85.0}
            found = False
            if scale_match:
                scale_text = scale_match.group(0)
                pairs = re.findall(r'(\d+(?:\.\d+)?)\s*%\s*(\d)', scale_text)
                if pairs:
                    found = True
                    for val, grade in pairs:
                        sub_boundaries[grade] = float(val)
                else:
                    pairs2 = re.findall(r'(\d)\s*:\s*(\d+(?:\.\d+)?)\s*%', scale_text)
                    if pairs2:
                        found = True
                        for grade, val in pairs2:
                            sub_boundaries[grade] = float(val)
            if not found:
                for t in soup_task.find_all('table'):
                    t_text = t.get_text(" ", strip=True)
                    if "%" in t_text:
                        pairs = re.findall(r'(\d+(?:\.\d+)?)\s*%\s*(\d)', t_text)
                        if pairs:
                            for val, grade in pairs:
                                sub_boundaries[grade] = float(val)
                            break
            boundaries[sub] = sub_boundaries
            
        with open(BOUNDARIES_FILE, "w", encoding="utf-8") as f:
            json.dump(boundaries, f, indent=2, ensure_ascii=False)
        return boundaries
    except Exception as e:
        print(f"Error extracting boundaries: {e}")
        return {}

def extract_csrf_token(soup):
    csrf_input = soup.find('input', {'name': 'authenticity_token'})
    if csrf_input and csrf_input.get('value'):
        return csrf_input['value']
    csrf_meta = soup.find('meta', {'name': 'csrf-token'})
    if csrf_meta and csrf_meta.get('content'):
        return csrf_meta['content']
    return None

def run():
    # Allow address reuse to facilitate easy server restarts
    socketserver.TCPServer.allow_reuse_address = True
    with HTTPServer(("", PORT), DashboardHandler) as httpd:
        print(f"ManageBac Dashboard Server running locally at http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
            httpd.server_close()

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--run-scraper":
        import scraper
        scraper.main()
    else:
        run()
