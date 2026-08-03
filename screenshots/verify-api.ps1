Write-Host "=== BACKEND API VERIFICATION ==="
$endpoints = @('/api/leads','/api/ai/scores','/api/whatsapp/status','/api/email/status','/api/leads/filters')
foreach ($ep in $endpoints) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:5001$ep" -TimeoutSec 5 -ErrorAction Stop
        Write-Host "$ep -> Status: $($r.StatusCode), Length: $($r.Content.Length)"
    } catch {
        Write-Host "$ep -> FAILED: $($_.Exception.Message)"
    }
}
Write-Host ""
Write-Host "=== FRONTEND BUILD CHECK ==="
Write-Host "Build folder exists: $(Test-Path 'C:\AI-LeadGen-system\frontend\build\index.html')"
Write-Host "Main JS exists: $((Get-ChildItem 'C:\AI-LeadGen-system\frontend\build\static\js\main.*.js').Count -gt 0)"
Write-Host "Main CSS exists: $((Get-ChildItem 'C:\AI-LeadGen-system\frontend\build\static\css\main.*.css').Count -gt 0)"
Write-Host ""
Write-Host "=== PROCESS CHECK ==="
Get-Process -Id 18000 -ErrorAction SilentlyContinue | Select-Object Id,Name,StartTime | Format-Table -AutoSize
Get-Process -Id 19956 -ErrorAction SilentlyContinue | Select-Object Id,Name,StartTime | Format-Table -AutoSize
