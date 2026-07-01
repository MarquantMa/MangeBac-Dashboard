import os
import sys
import threading
import time
import webview
import server

# Intercept background scraper execution if triggered by the server
if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == "--run-scraper":
        import scraper
        scraper.main()
        sys.exit(0)

def start_server():
    try:
        server.run()
    except Exception as e:
        print(f"Error starting backend server: {e}")

def main():
    # Start the local backend server on port 8082 in a daemon thread
    t = threading.Thread(target=start_server, daemon=True)
    t.start()
    
    # Wait a brief moment to ensure the server starts listening
    time.sleep(0.5)
    
    # Create the native app window using pywebview (uses WebKit on Mac and WebView2 on Windows)
    window = webview.create_window(
        title="ManageBac Student Dashboard",
        url="http://127.0.0.1:8082/?v=2.0.2",
        width=1200,
        height=850,
        resizable=True,
        min_size=(1000, 700)
    )
    
    # Run the pywebview loop (this is blocking until the window is closed)
    webview.start()

if __name__ == '__main__':
    main()
