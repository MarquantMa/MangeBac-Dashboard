#!/usr/bin/env python3
import os
import shutil
import subprocess
import json
import re

PROJECT_DIR = "/Users/vahram/ManagebacDashboard"
BUILD_DIR = "/tmp/mb_pywebview_build"
APP_NAME = "ManagebacDashboard"
APP_BUNDLE_NAME = f"{APP_NAME}.app"
DOWNLOADS_DIR = os.path.expanduser("~/Downloads")

def clean_and_setup():
    print("Cleaning up old build directories...")
    if os.path.exists(BUILD_DIR):
        shutil.rmtree(BUILD_DIR)
    os.makedirs(BUILD_DIR, exist_ok=True)

def clean_personal_info(filepath):
    print(f"Sanitizing personal info in {filepath}...")
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
        
    # Remove hardcoded credentials
    content = re.sub(r'MB_USER\s*=\s*"[^"]*"', 'MB_USER = ""', content)
    content = re.sub(r'MB_PASS\s*=\s*"[^"]*"', 'MB_PASS = ""', content)
    content = re.sub(r'BASE_URL\s*=\s*"[^"]*"', 'BASE_URL = "https://sdgj.managebac.cn"', content)
    
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

def clean_html_personal_info(filepath):
    print(f"Sanitizing HTML personal info in {filepath}...")
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
        
    content = content.replace("HaoranMa0818@icloud.com", "student@school.edu")
    content = content.replace("Marquant Ma", "Student Name")
    content = content.replace("MM", "ST")
    
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

def compile_mac_app():
    print("Compiling macOS App using PyInstaller...")
    sources_dir = os.path.join(BUILD_DIR, "sources")
    os.makedirs(sources_dir, exist_ok=True)
    
    # Copy all necessary Python files and assets to sources dir
    files_to_copy = ["main.py", "server.py", "scraper.py", "index.html", "app.js", "style.css", "AppIcon.icns"]
    for filename in files_to_copy:
        shutil.copy2(os.path.join(PROJECT_DIR, filename), os.path.join(sources_dir, filename))
        
    # Sanitize credentials and personal info in files
    clean_personal_info(os.path.join(sources_dir, "server.py"))
    clean_personal_info(os.path.join(sources_dir, "scraper.py"))
    clean_html_personal_info(os.path.join(sources_dir, "index.html"))
    
    # Run PyInstaller with --windowed/--noconsole option
    cmd = [
        "/opt/miniconda3/bin/pyinstaller",
        "--clean",
        "--noconsole",
        "--name", APP_NAME,
        "--icon", os.path.join(sources_dir, "AppIcon.icns"),
        "--add-data", f"{os.path.join(sources_dir, 'index.html')}:.",
        "--add-data", f"{os.path.join(sources_dir, 'app.js')}:.",
        "--add-data", f"{os.path.join(sources_dir, 'style.css')}:.",
        "--distpath", os.path.join(BUILD_DIR, "dist"),
        "--workpath", os.path.join(BUILD_DIR, "build"),
        os.path.join(sources_dir, "main.py")
    ]
    try:
        subprocess.run(cmd, check=True)
        print("macOS App Bundle compiled successfully.")
        
        # Deep sign the app bundle
        app_path = os.path.join(BUILD_DIR, "dist", APP_BUNDLE_NAME)
        print(f"Ad-hoc codesigning the app bundle at {app_path}...")
        subprocess.run(["codesign", "-s", "-", "--force", "--deep", app_path], check=True)
        print("Codesigned successfully.")
    except Exception as e:
        print(f"Error compiling macOS App: {e}")
        exit(1)

def build_mac_dmg():
    print("Building macOS DMG...")
    dmg_dst = os.path.join(DOWNLOADS_DIR, f"{APP_NAME}.dmg")
    if os.path.exists(dmg_dst):
        os.remove(dmg_dst)
        
    stage_dir = "/tmp/mb_pywebview_dmg_stage"
    if os.path.exists(stage_dir):
        shutil.rmtree(stage_dir)
    os.makedirs(stage_dir, exist_ok=True)
    
    # Copy app bundle to stage directory
    app_path = os.path.join(BUILD_DIR, "dist", APP_BUNDLE_NAME)
    shutil.copytree(app_path, os.path.join(stage_dir, APP_BUNDLE_NAME), symlinks=True)
    
    cmd = [
        "hdiutil", "create",
        "-volname", APP_NAME,
        "-srcfolder", stage_dir,
        "-ov",
        "-format", "UDZO",
        dmg_dst
    ]
    try:
        subprocess.run(cmd, check=True)
        print(f"macOS DMG created successfully at: {dmg_dst}")
    except Exception as e:
        print(f"Error building DMG: {e}")
        exit(1)
    finally:
        if os.path.exists(stage_dir):
            shutil.rmtree(stage_dir)

def prepare_windows_package():
    print("Preparing Windows packaging source folder...")
    win_dir = os.path.join(BUILD_DIR, "windows_source")
    os.makedirs(win_dir, exist_ok=True)
    
    # Copy files
    files_to_copy = ["main.py", "server.py", "scraper.py", "index.html", "app.js", "style.css"]
    for filename in files_to_copy:
        shutil.copy2(os.path.join(PROJECT_DIR, filename), os.path.join(win_dir, filename))
        
    # Sanitize
    clean_personal_info(os.path.join(win_dir, "server.py"))
    clean_personal_info(os.path.join(win_dir, "scraper.py"))
    clean_html_personal_info(os.path.join(win_dir, "index.html"))
    
    # Convert AppIcon.icns to AppIcon.ico for Windows if we can (or just use a placeholder/copy)
    # Since we don't have direct ico tool, we write instructions in bat file
    
    # Create build_win.bat launcher
    bat_content = """@echo off
title Build ManagebacDashboard Windows Executable
echo ==========================================================
echo  Building Managebac Dashboard Windows Application
echo ==========================================================
echo.
echo Step 1: Installing dependencies...
pip install pywebview requests beautifulsoup4 pyinstaller
echo.
echo Step 2: Compiling using PyInstaller...
pyinstaller --clean --noconsole --name "ManagebacDashboard" --add-data "index.html;." --add-data "app.js;." --add-data "style.css;." main.py
echo.
echo Build Complete! The standalone executable is inside "dist/ManagebacDashboard/ManagebacDashboard.exe".
pause
"""
    with open(os.path.join(win_dir, "build_win.bat"), "w", encoding="utf-8") as f:
        f.write(bat_content)
        
    # Create README.txt
    readme_content = """ManageBac Student Dashboard - Windows Builder
=================================================

Instructions to build the standalone Windows application:
1. Extract this ZIP file on a Windows computer with Python installed.
2. Double-click the "build_win.bat" file.
3. Once completed, you will find the standalone Windows application folder in:
   dist\\ManagebacDashboard\\
4. Double-click "ManagebacDashboard.exe" to run the application directly.
"""
    with open(os.path.join(win_dir, "README.txt"), "w", encoding="utf-8") as f:
        f.write(readme_content)
        
    # Zip the windows folder and place in Downloads
    zip_dst = os.path.join(DOWNLOADS_DIR, f"{APP_NAME}_Windows_Builder")
    shutil.make_archive(zip_dst, 'zip', win_dir)
    print(f"Windows Package ZIP created successfully at: {zip_dst}.zip")

def main():
    clean_and_setup()
    compile_mac_app()
    build_mac_dmg()
    prepare_windows_package()
    print("\nAll packaging tasks completed successfully!")

if __name__ == "__main__":
    main()
