#!/usr/bin/env python3
import os
import sys
import json
import datetime
import re
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin
from concurrent.futures import ThreadPoolExecutor


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

CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
TASKS_FILE = os.path.join(DATA_DIR, "tasks_all.json")
STATUS_FILE = os.path.join(DATA_DIR, "sync_status.json")
LOG_FILE = os.path.join(DATA_DIR, "scraper.log")

def log_message(msg):
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_line = f"[{timestamp}] {msg}"
    print(log_line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(log_line + "\n")
    except Exception as e:
        print(f"Failed to write to log file: {e}")

def update_status(status, message, progress=0):
    status_data = {
        "status": status,
        "message": message,
        "progress": progress,
        "timestamp": datetime.datetime.now().isoformat()
    }
    # Keep last_sync if success
    if status == "success":
        status_data["last_sync"] = status_data["timestamp"]
    else:
        # Try to read existing last_sync
        if os.path.exists(STATUS_FILE):
            try:
                with open(STATUS_FILE, "r", encoding="utf-8") as f:
                    old_data = json.load(f)
                    if "last_sync" in old_data:
                        status_data["last_sync"] = old_data["last_sync"]
            except:
                pass
                
    try:
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            json.dump(status_data, f, indent=2)
    except Exception as e:
        log_message(f"Failed to write status file: {e}")

def parse_tile(tile, current_date_header, view_name, base_url):
    # Title & URL
    title_a = tile.find('a', class_='f-tile__title-link')
    title = ""
    url = ""
    if title_a:
        title = title_a.get_text(strip=True)
        url = title_a.get('href', '')
        
    # Description (time, subject, badges)
    desc_div = tile.find(class_='f-tile__description')
    time_text = ""
    subject = ""
    badges = []
    
    if desc_div:
        hstack = desc_div.find(class_='hstack')
        if hstack:
            # Time is usually in the first span containing clock icon or a date
            spans = hstack.find_all('span', recursive=False)
            for span in spans:
                if 'vr' in span.get('class', []):
                    continue
                if span.find('svg') or (span.get_text() and any(m in span.get_text() for m in ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])):
                    time_text = span.get_text(strip=True)
                    break
            
            # Subject link
            subject_a = hstack.find('a', class_='link-dark')
            if subject_a:
                subject = subject_a.get_text(strip=True)
                
            # Badges
            for badge in hstack.find_all(class_='badge'):
                badge_lbl = badge.find(class_='badge-label')
                if badge_lbl:
                    badges.append(badge_lbl.get_text(strip=True))
                else:
                    badges.append(badge.get_text(strip=True))
                    
            # Other labels (like Online Assessment)
            for lbl in hstack.find_all(class_='label'):
                badges.append(lbl.get_text(strip=True))
    
    # Suffix (Score / Status)
    suffix = tile.find(class_='f-tile__suffix')
    status = ""
    score = None
    points = None
    
    if suffix:
        score_div = suffix.find(class_='f-task-score')
        if score_div:
            status_classes = score_div.get('class', [])
            if 'f-task-score--assessment' in status_classes:
                status = "Assessed"
                h4_grade = score_div.find('h4')
                if h4_grade:
                    score = h4_grade.get_text(strip=True)
                p_pts = score_div.find('p')
                if p_pts:
                    points = p_pts.get_text(strip=True)
            elif 'f-task-score--not-assessed' in status_classes:
                status = "Not Assessed"
            else:
                status = score_div.get_text(strip=True)
                
    return {
        "id": url.split('/')[-1] if url else "",
        "title": title,
        "url": urljoin(base_url, url) if url else "",
        "date_header": current_date_header,
        "time": time_text,
        "subject": subject,
        "badges": badges,
        "status": status,
        "score": score,
        "points": points,
        "view": view_name
    }

def parse_page_tasks(soup, view_name, base_url):
    container = soup.find(class_='js-tasks')
    if not container:
        return []
    
    page_tasks = []
    current_date_header = None
    
    # Iterate through children
    for child in container.find_all(recursive=False):
        classes = child.get('class', [])
        if 'text-secondary' in classes and 'mb-n2' in classes:
            current_date_header = child.get_text(strip=True)
        elif 'f-tile__wrapper' in classes:
            tile = child.find(class_='f-task-tile')
            if tile:
                page_tasks.append(parse_tile(tile, current_date_header, view_name, base_url))
        elif 'f-task-tile' in classes:
            page_tasks.append(parse_tile(child, current_date_header, view_name, base_url))
            
    return page_tasks

def main():
    log_message("Starting task crawling...")
    update_status("syncing", "Starting synchronization...", 5)
    
    # Load configuration
    if not os.path.exists(CONFIG_FILE):
        log_message("Configuration file not found.")
        update_status("error", "Configuration file config.json missing.")
        sys.exit(1)
        
    enable_system_reminders = False
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            config = json.load(f)
            email = config["email"]
            password = config["password"]
            subdomain = config.get("school_subdomain", "sdgj.managebac.cn")
            subdomain = subdomain.strip().replace("https://", "").replace("http://", "").split("/")[0]
            enable_system_reminders = config.get("enable_system_reminders", False)
    except Exception as e:
        log_message(f"Error reading config: {e}")
        update_status("error", f"Config parse error: {e}")
        sys.exit(1)
        
    base_url = f"https://{subdomain}"
    login_url = f"{base_url}/login"
    login_post_url = f"{base_url}/sessions"
    
    # Setup Session
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    })
    
    try:
        # Fetch login page for CSRF token
        log_message("Fetching login page...")
        update_status("syncing", "Connecting to ManageBac...", 10)
        resp = session.get(login_url, timeout=20)
        if resp.status_code != 200:
            raise Exception(f"Failed to load login page (HTTP {resp.status_code})")
            
        soup = BeautifulSoup(resp.text, 'html.parser')
        token_input = soup.find('input', {'name': 'authenticity_token'})
        if not token_input:
            raise Exception("CSRF authenticity token not found on login page.")
        csrf_token = token_input.get('value')
        
        # Log in
        log_message("Submitting login credentials...")
        update_status("syncing", "Logging in...", 20)
        payload = {
            "authenticity_token": csrf_token,
            "login": email,
            "password": password,
            "remember_me": "1",
            "commit": "Sign in"
        }
        resp_login = session.post(login_post_url, data=payload, allow_redirects=True, timeout=20)
        
        if "student" not in resp_login.url:
            raise Exception("Authentication failed. Please verify your email and password.")
            
        log_message("Login successful.")
        update_status("syncing", "Logged in. Fetching tasks...", 30)
        
        all_tasks = {}
        if os.path.exists(TASKS_FILE):
            try:
                with open(TASKS_FILE, "r", encoding="utf-8") as f:
                    existing_list = json.load(f)
                    for t in existing_list:
                        if "id" in t:
                            all_tasks[t["id"]] = t
            except Exception as e:
                log_message(f"Error loading existing tasks: {e}")
                
        views = [("upcoming", 40), ("past", 60), ("overdue", 85)]
        
        # We estimate the progress step sizes
        for view, base_progress in views:
            url = f"{base_url}/student/tasks_and_deadlines?view={view}"
            page = 1
            
            while url:
                log_message(f"Fetching {view} page {page}...")
                update_status("syncing", f"Fetching {view} tasks (Page {page})...", min(base_progress + page * 2, 95))
                
                resp_view = session.get(url, timeout=20)
                if resp_view.status_code != 200:
                    log_message(f"Error fetching page {page} for {view}: Status {resp_view.status_code}")
                    break
                    
                soup_view = BeautifulSoup(resp_view.text, 'html.parser')
                tasks_found = parse_page_tasks(soup_view, view, base_url)
                log_message(f"  Parsed {len(tasks_found)} tasks.")
                
                for t in tasks_found:
                    t_id = t["id"]
                    if t_id:
                        if t_id in all_tasks:
                            # Merge views
                            all_tasks[t_id]["views"] = list(set(all_tasks[t_id].get("views", []) + [view]))
                            if not all_tasks[t_id]["status"] and t["status"]:
                                all_tasks[t_id]["status"] = t["status"]
                            if not all_tasks[t_id]["score"] and t["score"]:
                                all_tasks[t_id]["score"] = t["score"]
                        else:
                            t["views"] = [view]
                            all_tasks[t_id] = t
                            
                # Check pagination (must contain tasks_and_deadlines and text 'Show More' or 'next' class)
                next_link = None
                for a in soup_view.find_all('a', href=True):
                    text = a.get_text(strip=True)
                    href = a['href']
                    classes = a.get('class', [])
                    
                    if 'tasks_and_deadlines' in href and ('Show More' in text or 'next' in classes):
                        next_link = href
                        break
                        
                if next_link:
                    url = urljoin(base_url, next_link)
                    page += 1
                else:
                    url = None
                    
        tasks_list = list(all_tasks.values())
        log_message(f"Crawl finished. Found {len(tasks_list)} unique tasks.")
        
        # Create reminders for upcoming tasks one day ahead
        if enable_system_reminders:
            try:
                create_reminders_for_upcoming_tasks(tasks_list)
            except Exception as rem_ex:
                log_message(f"Error creating reminders: {rem_ex}")
        else:
            log_message("System reminders integration is disabled. Skipping reminder creation.")
        
        # Save tasks file
        with open(TASKS_FILE, "w", encoding="utf-8") as f:
            json.dump(tasks_list, f, indent=2, ensure_ascii=False)
            
        # Extract and save subject grades, category weights, and boundaries directly from the web
        try:
            extract_and_save_grades_and_boundaries(session, base_url, resp_login.text)
        except Exception as e_grades:
            log_message(f"Error during grades and boundaries extraction: {e_grades}")
            
        update_status("success", f"Sync completed! Found {len(tasks_list)} tasks.", 100)
        log_message("Task crawl successfully finished.")
        
    except Exception as ex:
        log_message(f"Sync failed: {ex}")
        update_status("error", f"Sync failed: {ex}")
        sys.exit(1)

def extract_classes_from_html(html):
    soup = BeautifulSoup(html, 'html.parser')
    classes = {}
    
    classes_menu = soup.find(class_='js-menu-classes-list')
    if classes_menu:
        for a in classes_menu.find_all('a', href=True):
            href = a['href']
            match = re.search(r'/student/classes/(\d+)', href)
            if match:
                class_id = match.group(1)
                title_span = a.find(class_='f-menu__submenu-link-title')
                if title_span:
                    class_name = title_span.get_text(strip=True)
                    classes[class_name] = class_id
                else:
                    class_name = a.get_text(strip=True)
                    if class_name:
                        classes[class_name] = class_id
                        
    for a in soup.find_all('a', href=True):
        href = a['href']
        if re.match(r'^/student/classes/(\d+)$', href):
            class_id = re.search(r'/student/classes/(\d+)', href).group(1)
            class_name = a.get_text(strip=True)
            if class_name and "Browse All Classes" not in class_name and class_name not in classes:
                classes[class_name] = class_id
                
    return classes

def find_task_link_from_class_page(soup):
    for card in soup.find_all(class_='fusion-card-item'):
        a_tag = card.find('a', href=True)
        if a_tag and '/core_tasks/' in a_tag['href']:
            return a_tag['href']
    for a in soup.find_all('a', href=True):
        if '/core_tasks/' in a['href'] and len(a['href'].split('/')) >= 6:
            return a['href']
    return None

def extract_boundaries_from_task_html(soup, sub_boundaries):
    text = soup.get_text(" ", strip=True)
    scale_match = re.search(r'(?:Task Grade Scale|Grade Scale|Score\s+Mark)\s*(.*?)(?:Author|Comments|Dropbox|Student|Add Entry|$)', text, re.I | re.S)
    
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
        for t in soup.find_all('table'):
            t_text = t.get_text(" ", strip=True)
            if "%" in t_text:
                pairs = re.findall(r'(\d+(?:\.\d+)?)\s*%\s*(\d)', t_text)
                if pairs:
                    for val, grade in pairs:
                        sub_boundaries[grade] = float(val)
                    break
    return sub_boundaries


def parse_task_date(task):
    text = task.get("time") or task.get("date_header") or ""
    match = re.search(r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)', text, re.IGNORECASE)
    if not match:
        return None
    
    month_map = {
        "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
        "jul": 7, "avg": 8, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12
    }
    month = month_map[match.group(1).lower()]
    day = int(match.group(2))
    
    year = 2026
    views = task.get("views", [])
    if month > 6 and ("past" in views or "overdue" in views):
        year = 2025
        
    time_match = re.search(r'(\d+):(\d+)\s+(AM|PM)', text, re.IGNORECASE)
    hour = 9
    minute = 0
    if time_match:
        hour = int(time_match.group(1))
        minute = int(time_match.group(2))
        ampm = time_match.group(3).lower()
        if ampm == "pm" and hour < 12:
            hour += 12
        elif ampm == "am" and hour == 12:
            hour = 0
            
    try:
        return datetime.datetime(year, month, day, hour, minute)
    except Exception as e:
        return None

def get_existing_reminder_names():
    import subprocess
    applescript = '''
    tell application "Reminders"
        try
            set namesList to name of every reminder of default list whose name starts with "ManageBac: "
            set resultText to ""
            repeat with nameItem in namesList
                set resultText to resultText & nameItem & "\n"
            end repeat
            return resultText
        on error
            return ""
        end try
    end tell
    '''
    try:
        res = subprocess.run(["osascript"], input=applescript, capture_output=True, text=True, encoding="utf-8", timeout=60)
        names = [line.strip() for line in res.stdout.split("\n") if line.strip()]
        return names
    except Exception as e:
        log_message(f"Failed to fetch existing reminders list: {e}")
        return []

def create_reminders_for_upcoming_tasks(tasks_list):
    log_message("Creating reminders in Reminders app for upcoming tasks...")
    import subprocess
    
    count_created = 0
    now = datetime.datetime.now()
    
    # 1. Get all existing ManageBac reminder names at once (highly optimized)
    existing_reminder_names = get_existing_reminder_names()
    log_message(f"Found {len(existing_reminder_names)} existing ManageBac reminders in Reminders app.")
    
    for task in tasks_list:
        title = task.get("title", "")
        full_reminder_name = f"ManageBac: {title}"
        
        # 2. Skip if already cached or exists
        if task.get("reminder_created"):
            continue
            
        if full_reminder_name in existing_reminder_names:
            task["reminder_created"] = True
            continue
            
        views = task.get("views", [])
        if "upcoming" not in views:
            continue
            
        task_date = parse_task_date(task)
        if not task_date:
            continue
            
        remind_date = task_date - datetime.timedelta(days=1)
        if remind_date <= now:
            continue
            
        subject = task.get("subject", "")
        due_str = task.get("time") or task.get("date_header") or ""
        url = task.get("url", "")
        
        year = remind_date.year
        month_names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
        month_name = month_names[remind_date.month - 1]
        day = remind_date.day
        seconds_from_midnight = remind_date.hour * 3600 + remind_date.minute * 60
        
        escaped_title = title.replace('"', '\\"').replace('\\', '\\\\')
        escaped_subject = subject.replace('"', '\\"').replace('\\', '\\\\')
        escaped_due = due_str.replace('"', '\\"').replace('\\', '\\\\')
        escaped_url = url.replace('"', '\\"').replace('\\', '\\\\')
        
        applescript = f'''
        tell application "Reminders"
            set todoList to default list
            tell todoList
                if not (exists (reminders whose name is "ManageBac: {escaped_title}")) then
                    set targetDate to (current date)
                    set day of targetDate to 1 -- avoid month overflow bug
                    set year of targetDate to {year}
                    set month of targetDate to {month_name}
                    set day of targetDate to {day}
                    set time of targetDate to {seconds_from_midnight}
                    make new reminder with properties {{name:"ManageBac: {escaped_title}", due date:targetDate, body:"Subject: {escaped_subject}\\nDue: {escaped_due}\\nURL: {escaped_url}"}}
                    return "Created"
                else
                    return "Exists"
                end if
            end tell
        end tell
        '''
        
        try:
            # Run AppleScript via stdin to handle unicode and set a 30s timeout
            res = subprocess.run(["osascript"], input=applescript, capture_output=True, text=True, encoding="utf-8", timeout=30)
            result_str = res.stdout.strip()
            if "Created" in result_str:
                log_message(f"Created reminder: '{full_reminder_name}' for {remind_date}")
                task["reminder_created"] = True
                count_created += 1
            elif "Exists" in result_str:
                log_message(f"Reminder verified in Reminders app: '{full_reminder_name}'")
                task["reminder_created"] = True
        except Exception as e:
            log_message(f"Failed to create reminder for '{title}': {e}")
            
    log_message(f"Reminder creation finished. Created {count_created} new reminders.")

def extract_and_save_grades_and_boundaries(session, base_url, dashboard_html):
    log_message("Extracting enrolled classes list...")
    classes = extract_classes_from_html(dashboard_html)
    
    try:
        resp_classes = session.get(f"{base_url}/student/classes/my", timeout=20)
        if resp_classes.status_code == 200:
            classes.update(extract_classes_from_html(resp_classes.text))
    except Exception as e_cls:
        log_message(f"Failed to fetch classes list page: {e_cls}")
        
    log_message(f"Found {len(classes)} enrolled classes to sync grades and boundaries.")
    
    grades_file = os.path.join(DATA_DIR, "subject_grades.json")
    boundaries_file = os.path.join(DATA_DIR, "subject_boundaries.json")
    
    grades = {}
    if os.path.exists(grades_file):
        try:
            with open(grades_file, "r", encoding="utf-8") as f:
                grades = json.load(f)
        except Exception as e:
            log_message(f"Error loading existing grades: {e}")
            
    boundaries = {}
    if os.path.exists(boundaries_file):
        try:
            with open(boundaries_file, "r", encoding="utf-8") as f:
                boundaries = json.load(f)
        except Exception as e:
            log_message(f"Error loading existing boundaries: {e}")
            
    def fetch_class_data(sub, class_id):
        url = f"{base_url}/student/classes/{class_id}/core_tasks"
        try:
            log_message(f"Parallel sync class {sub} (ID: {class_id})...")
            res = session.get(url, timeout=20)
            if res.status_code != 200:
                log_message(f"Failed to fetch class page for {sub}: {res.status_code}")
                return sub, None, None
                
            soup = BeautifulSoup(res.text, 'html.parser')
            
            class_name = sub
            breadcrumb = soup.find(class_="breadcrumb")
            if breadcrumb:
                for a in breadcrumb.find_all("a", href=True):
                    href = a["href"]
                    if re.match(r'^/student/classes/\d+$', href):
                        class_name = a.get_text(strip=True)
                        break
                        
            sidebar = soup.find(class_="sidebar-items-list")
            if not sidebar:
                return sub, None, None
                
            items = sidebar.find_all(class_="list-item")
            categories = []
            overall_percentage = None
            overall_grade = None
            
            for item in items:
                cells = item.find_all(class_="cell")
                if len(cells) >= 2:
                    cat_cell = cells[0]
                    val_cell = cells[1]
                    
                    label_div = cat_cell.find(class_="label")
                    if label_div:
                        cat_text = label_div.get_text(" ", strip=True)
                    else:
                        cat_text = cat_cell.get_text(" ", strip=True)
                        
                    val_text = val_cell.get_text(" ", strip=True)
                    
                    if cat_text == "Category (Weight)":
                        continue
                        
                    weight = 0.0
                    weight_match = re.search(r'\((\d+(?:\.\d+)?)\s*%\)', cat_text)
                    if weight_match:
                        weight = float(weight_match.group(1))
                        
                    grade = None
                    percentage = None
                    
                    strong = val_cell.find("strong")
                    if strong:
                        grade_str = strong.get_text(strip=True)
                        if grade_str.isdigit():
                            grade = int(grade_str)
                            
                    pct_match = re.search(r'\((\d+(?:\.\d+)?)\s*%\)', val_text)
                    if pct_match:
                        percentage = float(pct_match.group(1))
                        
                    cat_name_clean = re.sub(r'\s*\(\d+(?:\.\d+)?\s*%\)\s*$', '', cat_text).strip()
                    
                    if cat_text.startswith("Overall"):
                        overall_percentage = percentage
                        overall_grade = grade
                    else:
                        categories.append({
                            "name": cat_name_clean,
                            "weight": weight,
                            "grade": grade,
                            "percentage": percentage,
                            "raw_value": val_text
                        })
                        
            sub_grades = {
                "class_name": class_name,
                "overall_percentage": overall_percentage,
                "overall_grade": overall_grade,
                "categories": categories
            }
            
            sub_boundaries = boundaries.get(sub, {}).copy()
            if not sub_boundaries or "6" not in sub_boundaries or "7" not in sub_boundaries:
                task_href = find_task_link_from_class_page(soup)
                if task_href:
                    task_url = urljoin(base_url, task_href)
                    log_message(f"Fetching task for boundaries of {sub}: {task_url}")
                    task_res = session.get(task_url, timeout=20)
                    if task_res.status_code == 200:
                        task_soup = BeautifulSoup(task_res.text, 'html.parser')
                        sub_boundaries = extract_boundaries_from_task_html(task_soup, sub_boundaries)
                        
            if not sub_boundaries:
                sub_boundaries = {"6": 70.0, "7": 85.0}
                
            return sub, sub_grades, sub_boundaries
            
        except Exception as ex:
            log_message(f"Error fetching data for class {sub}: {ex}")
            return sub, None, None

    subjects_to_fetch = list(classes.items())
    if subjects_to_fetch:
        with ThreadPoolExecutor(max_workers=min(8, len(subjects_to_fetch))) as executor:
            futures = [executor.submit(fetch_class_data, sub, class_id) for sub, class_id in subjects_to_fetch]
            for fut in futures:
                sub, sub_grades, sub_boundaries = fut.result()
                if sub_grades:
                    grades[sub] = sub_grades
                    log_message(f"Grades for {sub}: Overall {sub_grades.get('overall_percentage')}%")
                if sub_boundaries:
                    boundaries[sub] = sub_boundaries
                    
    with open(grades_file, "w", encoding="utf-8") as f:
        json.dump(grades, f, indent=2, ensure_ascii=False)
    with open(boundaries_file, "w", encoding="utf-8") as f:
        json.dump(boundaries, f, indent=2, ensure_ascii=False)
        
    log_message("Enrolled classes sync complete (grades and boundaries saved).")

if __name__ == "__main__":
    main()
