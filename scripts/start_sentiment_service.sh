#!/bin/bash

# Ensure python3-venv is installed
# sudo apt-get install python3-venv -y

# Create venv if not exists
if [ ! -d "sentiment/venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv sentiment/venv
fi

# Activate venv
source sentiment/venv/bin/activate

# Install requirements
echo "Installing dependencies..."
pip install -r sentiment/requirements.txt

# Start service
echo "Starting Sentiment Service..."
uvicorn sentiment.service:app --reload --port 8000
