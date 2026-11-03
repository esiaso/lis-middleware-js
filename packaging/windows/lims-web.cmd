@echo off
rem Web CLI from the release bundle, for: lims-web create-user <username> "<display name>" <roles> < password-file
setlocal
set "HERE=%~dp0.."
if not defined DATABASE_URL if not defined DATABASE_URL_FILE if exist "C:\ProgramData\LIMS Middleware\secrets\database_url" set "DATABASE_URL_FILE=C:\ProgramData\LIMS Middleware\secrets\database_url"
"%HERE%\runtime\node\node.exe" "%HERE%\app\node_modules\@lis\web\dist\main.js" %*
