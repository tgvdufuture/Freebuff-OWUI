@echo off
setlocal
rem Lance le pont + OpenWebUI avec le bash de Git pour Windows.
rem Depuis PowerShell, "bash" resout souvent vers WSL (C:\Windows\System32\bash.exe),
rem ou node n'existe pas : le script echoue avec "node: command not found".
set "GITBASH="
for /f "delims=" %%G in ('where git 2^>nul') do (
  if not defined GITBASH (
    for %%D in ("%%~dpG..") do (
      if exist "%%~fD\bin\bash.exe" set "GITBASH=%%~fD\bin\bash.exe"
    )
  )
)
if not defined GITBASH if exist "%ProgramFiles%\Git\bin\bash.exe" set "GITBASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined GITBASH (
  echo Git Bash introuvable : installe Git pour Windows, puis relance.
  exit /b 1
)
"%GITBASH%" "%~dp0start-all.sh" %*
exit /b %ERRORLEVEL%
