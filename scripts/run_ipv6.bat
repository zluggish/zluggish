@ECHO OFF
REM Configure network.host to "::" in server/zluggish.config.ts first.
PUSHD "%~dp0.."
node server\dist\src\main.js
POPD
