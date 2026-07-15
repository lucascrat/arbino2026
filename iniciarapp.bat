@echo off
cd /d "%~dp0"
echo ========================================
echo   Arbinomo - Iniciando aplicacao...
echo ========================================
echo.
echo Compilando projeto...
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo ERRO: Falha na compilacao. Execute 'npm install' primeiro.
    pause
    exit /b 1
)
echo.
echo Iniciando Electron...
echo.
".\node_modules\electron\dist\electron.exe" .
pause
