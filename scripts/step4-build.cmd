@echo off
rem Step 4: build Chromium. Safe to re-run after a stop/restart: it continues where it left off.
set PATH=C:\src\depot_tools;%PATH%
set DEPOT_TOOLS_WIN_TOOLCHAIN=0
cd /d C:\src\chromium\src
echo ==== %DATE% %TIME% build start
call autoninja -j 14 -C out\Jonah chrome
set RC=%ERRORLEVEL%
echo ==== %DATE% %TIME% build end, exit code %RC%
exit /b %RC%
