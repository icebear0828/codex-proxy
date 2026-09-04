@echo off
setlocal EnableExtensions

pushd "%~dp0" >nul
if errorlevel 1 (
  echo Failed to enter the portable application directory.
  exit /b 1
)

set "NODE_BIN=%CODEX_PROXY_NODE%"
if /i "%~1"=="--node-path" (
  if "%~2"=="" (
    echo --node-path requires a path.
    popd
    exit /b 2
  )
  set "NODE_BIN=%~2"
  shift
  shift
)
if /i "%~1"=="-n" (
  if "%~2"=="" (
    echo -n requires a path.
    popd
    exit /b 2
  )
  set "NODE_BIN=%~2"
  shift
  shift
)
if /i "%~1:~0,3%"=="-n=" (
  set "NODE_BIN=%~1:~3%"
  shift
)
if "%NODE_BIN%"=="" (
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_BIN set "NODE_BIN=%%N"
)

if not defined NODE_BIN (
  call :node_help "Supported Node.js was not found."
  popd
  exit /b 127
)

for /f "tokens=1 delims=v." %%V in ('"%NODE_BIN%" --version 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
  call :node_help "Unable to determine Node.js version: %NODE_BIN%"
  popd
  exit /b 2
)
set "NODE_INVALID="
for /f "delims=0123456789" %%V in ("%NODE_MAJOR%") do set "NODE_INVALID=%%V"
if defined NODE_INVALID (
  call :node_help "Unable to determine Node.js version: %NODE_BIN%"
  popd
  exit /b 2
)
if %NODE_MAJOR% LSS 20 (
  call :node_help "Node.js 20 or newer is required; found major version %NODE_MAJOR%."
  popd
  exit /b 2
)

if "%~1"=="" (
  "%NODE_BIN%" "%CD%\app\server.mjs" --mode=auto
) else (
  "%NODE_BIN%" "%CD%\app\server.mjs" %*
)
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%

:node_help
echo %~1
echo This portable package does not include Node.js.
echo Install Node.js 20 or newer from https://nodejs.org/en/download/
echo Or run the server with a specific executable:
echo   set CODEX_PROXY_NODE=C:\Path\to\node.exe
echo   codex-proxy.exe -n C:\Path\to\node.exe -m auto
echo   codex-proxy.exe -p -m auto
echo The command launched by this entry point is:
echo   node "%CD%\app\server.mjs" --mode auto
if not exist "%SystemRoot%\System32\choice.exe" (
  echo choice.exe is unavailable; open https://nodejs.org/en/download/ manually.
  exit /b 0
)
"%SystemRoot%\System32\choice.exe" /C YN /N /T 15 /D N /M "Open the official Node.js download page now"
if errorlevel 2 exit /b 0
start "" "https://nodejs.org/en/download/" >nul 2>nul
exit /b 0
