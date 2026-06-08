from dotenv import load_dotenv
load_dotenv()

import os
import sys

# Ensure this file's directory is on sys.path so `python.main` is importable
_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)

# Change working directory to the server root so relative paths (uploads/) work
os.chdir(_here)

import uvicorn
from python.main import app  # noqa: F401

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=port,
        reload=False,
    )
