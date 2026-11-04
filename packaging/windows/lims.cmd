@echo off
rem Operations CLI from the release bundle: lims verify | status | db migrate | config validate | secrets set <name> | diag tcp|bundle | version
setlocal
set "HERE=%~dp0.."
if not defined DATABASE_URL if not defined DATABASE_URL_FILE if exist "C:\ProgramData\LIMS Middleware\secrets\database_url" set "DATABASE_URL_FILE=C:\ProgramData\LIMS Middleware\secrets\database_url"
set "LIMS_HOME=%HERE%"
"%HERE%\runtime\node\node.exe" "%HERE%\app\node_modules\@lis\ops\dist\main.js" %*
