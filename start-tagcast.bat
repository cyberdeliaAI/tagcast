@echo off
rem Start Tagcast and open it in your browser (Windows). Close this window to stop it.
rem Uses uv when it is installed (set TAGCAST_NO_UV=1 to skip it); otherwise Python 3.11+
rem and a .venv next to this file.
setlocal
cd /d "%~dp0"

if defined TAGCAST_NO_UV goto :python
where uv >nul 2>nul
if not errorlevel 1 (
  uv run tagcast --open %*
  goto :done
)

:python

set "PYTHON=python"
where py >nul 2>nul
if not errorlevel 1 set "PYTHON=py -3"
%PYTHON% -c "import sys; sys.exit(sys.version_info < (3, 11))" >nul 2>nul
if errorlevel 1 (
  echo Tagcast needs Python 3.11 or newer, or uv.
  echo   Python: https://www.python.org/downloads/
  echo   uv:     https://docs.astral.sh/uv/getting-started/installation/
  goto :done
)

if not exist ".venv\Scripts\tagcast.exe" (
  echo First start: installing Tagcast in %CD%\.venv ...
  %PYTHON% -m venv .venv || goto :failed
  ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
  ".venv\Scripts\python.exe" -m pip install --quiet -e . || goto :failed
)

".venv\Scripts\tagcast.exe" --open %*
goto :done

:failed
echo Installing Tagcast failed. See the messages above.

:done
echo.
pause
