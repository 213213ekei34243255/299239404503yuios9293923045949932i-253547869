@echo off
rem Step 3: download Chromium 156.0.8078.96 source only (no history) into C:\src\chromium\src.
rem Safe to re-run after an interruption: gclient continues / repairs the checkout.
set PATH=C:\src\depot_tools;%PATH%
set DEPOT_TOOLS_WIN_TOOLCHAIN=0
cd /d C:\src\chromium
echo ==== %DATE% %TIME% gclient sync start
call gclient sync --nohooks --no-history -D --force --reset -j 8
if errorlevel 1 (echo ==== %DATE% %TIME% gclient sync FAILED errorlevel %ERRORLEVEL% & exit /b 1)
echo ==== %DATE% %TIME% gclient sync done
echo ==== %DATE% %TIME% gclient runhooks start
call gclient runhooks
if errorlevel 1 (echo ==== %DATE% %TIME% gclient runhooks FAILED errorlevel %ERRORLEVEL% & exit /b 1)
echo ==== %DATE% %TIME% gclient runhooks done
