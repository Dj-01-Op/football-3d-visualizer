#!/usr/bin/env sh
set -eu
python3 -m http.server 8000 --directory public --bind 127.0.0.1
