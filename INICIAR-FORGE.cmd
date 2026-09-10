@echo off
cd /d "%~dp0"
echo JPXFORGE - demonstracao local, sem API paga
where node >nul 2>nul
if errorlevel 1 (
  echo Instale o Node.js 24 LTS e tente novamente.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm ci
  if errorlevel 1 (
    echo Nao foi possivel instalar. Veja a mensagem acima.
    pause
    exit /b 1
  )
)
call npm run demo
echo.
echo A pasta da pagina gerada aparece no resultado acima.
pause
