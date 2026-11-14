@ECHO OFF
REM Configure network.host to "::" in your selected zluggish.config.ts first.
PUSHD "%~dp0.."
node server\dist\src\main.js
POPD
