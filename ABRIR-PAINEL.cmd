@echo off
cd /d "%~dp0"
echo JPXFORGE - painel de demonstracao
echo Apos iniciar, abra http://127.0.0.1:4100 no navegador.
echo Este modo usa exemplos fixos e nao consome API paga.
if not exist node_modules (
  call npm ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm run studio
if errorlevel 1 pause
