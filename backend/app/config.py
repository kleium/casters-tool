# config.py

import os
from dotenv import load_dotenv

load_dotenv()

# Blue Alliance API Key Configuration
# Set via environment variable TBA_API_KEY (loaded from .env locally)
BLUE_ALLIANCE_API_KEY = os.environ.get("TBA_API_KEY")
if not BLUE_ALLIANCE_API_KEY:
    raise ValueError(
        "TBA_API_KEY environment variable is not set. "
        "Create a .env file with TBA_API_KEY=your_key"
    )