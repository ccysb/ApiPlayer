# ApiPlayer 部署脚本（Cloudflare Workers）
# 用法: .\deploy.ps1 [-Dev]

param(
    [switch]$Dev
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "ApiPlayer 部署脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$action = if ($Dev) { "dev" } else { "deploy" }
Write-Host "[ApiPlayer] 正在执行 wrangler $action ..." -ForegroundColor Yellow

if ($Dev) {
    & pnpm wrangler dev
} else {
    & pnpm wrangler deploy
}

if ($LASTEXITCODE -eq 0) {
    Write-Host "[ApiPlayer] $(if ($Dev) { '预览已启动' } else { '部署成功' })!" -ForegroundColor Green
} else {
    Write-Host "[ApiPlayer] 操作失败，请检查 wrangler 登录状态与配置。" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "完成!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
