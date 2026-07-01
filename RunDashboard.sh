#!/bin/bash
echo "==================================================="
echo "  Starting ManageBac Student Dashboard Backend..."
echo "==================================================="
echo ""
echo "Launching local server on port 8082..."
python3 server.py &
SERVER_PID=$!
sleep 2
echo "Opening dashboard in your default browser..."
open http://localhost:8082 || xdg-open http://localhost:8082
echo ""
echo "To close the dashboard, press Ctrl+C in this terminal window."
trap "kill $SERVER_PID" EXIT
wait
