$testPage = Join-Path $PSScriptRoot 'engineering-core-browser-test.html'

if (-not (Test-Path $testPage)) {
    throw "Test page not found: $testPage"
}

Start-Process $testPage
Write-Output "Opened browser test page: $testPage"
Write-Output "Expected result: PASS - 40 tests passes, 0 tests en echec"
