[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$DshRoot,
    [switch]$CheckOnly,
    [switch]$Restore
)

$ErrorActionPreference = 'Stop'
$SupportedVersion = '0.1.1-rc.2'
$BackupSuffix = '.dsh-gemini-aistudio.bak'

function Resolve-DshRoot {
    if ($DshRoot) {
        return (Resolve-Path -LiteralPath $DshRoot).Path
    }
    $npmRoot = (& npm root -g).Trim()
    if (-not $npmRoot) {
        throw 'Unable to resolve the global npm root. Pass -DshRoot explicitly.'
    }
    $candidate = Join-Path $npmRoot '@deepseek-ai\dsh'
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
        throw "dsh was not found at $candidate. Pass -DshRoot explicitly."
    }
    return (Resolve-Path -LiteralPath $candidate).Path
}

function Read-PackageVersion([string]$PackageRoot) {
    $manifest = Join-Path $PackageRoot 'package.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
        throw "Missing package manifest: $manifest"
    }
    return (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version
}

function Set-ExactReplacement {
    param(
        [string]$Path,
        [string]$Before,
        [string]$After
    )
    $content = [IO.File]::ReadAllText($Path)
    if ($content.Contains($After)) {
        return 'already-patched'
    }
    if (-not $content.Contains($Before)) {
        throw "Refusing to patch an unknown dsh build: expected code was not found in $Path"
    }
    if ($CheckOnly) {
        return 'ready'
    }
    $backup = "$Path$BackupSuffix"
    if (-not (Test-Path -LiteralPath $backup)) {
        [IO.File]::Copy($Path, $backup, $false)
    }
    if ($PSCmdlet.ShouldProcess($Path, 'Enable complete model discovery metadata')) {
        [IO.File]::WriteAllText($Path, $content.Replace($Before, $After), [Text.UTF8Encoding]::new($false))
    }
    return 'patched'
}

$resolvedDshRoot = Resolve-DshRoot
$dshVersion = Read-PackageVersion $resolvedDshRoot
if ($dshVersion -ne $SupportedVersion) {
    throw "Unsupported dsh version $dshVersion. This patch only supports $SupportedVersion."
}

$nodeModules = Join-Path $resolvedDshRoot 'node_modules\@deepseek-ai'
$targets = @(
    Join-Path $nodeModules 'dsh-llm-pi-ai\lib\index.js'
    Join-Path $nodeModules 'dsh-llm\lib\index.js'
    Join-Path $nodeModules 'dsh-host-apiproxy\lib\index.js'
    Join-Path $nodeModules 'dsh-host-apiproxy\lib\types\api\llm.schema.js'
    Join-Path $nodeModules 'dsh-client-ui-settings-models\lib\client.js'
    Join-Path $nodeModules 'dsh-client-connection\lib\client.js'
)

if ($Restore) {
    foreach ($target in $targets) {
        $backup = "$target$BackupSuffix"
        if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
            throw "Backup not found: $backup"
        }
    }
    foreach ($target in $targets) {
        $backup = "$target$BackupSuffix"
        if ($PSCmdlet.ShouldProcess($target, 'Restore original dsh model discovery code')) {
            [IO.File]::Copy($backup, $target, $true)
        }
        Write-Host "restored $target"
    }
    Write-Host 'Restore complete. Restart dsh web.'
    exit 0
}

$piAiBefore = @'
		models.push({
			id,
			...name === void 0 ? {} : { name },
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens }
		});
'@
$piAiAfter = @'
		const input = Array.isArray(entry?.inputModalities) ? entry.inputModalities : Array.isArray(entry?.input_modalities) ? entry.input_modalities : void 0;
		const effortIds = Array.isArray(entry?.reasoningEfforts) ? entry.reasoningEfforts : Array.isArray(entry?.reasoning_efforts) ? entry.reasoning_efforts : void 0;
		const reasoningEfforts = entry?.reasoning === false ? false : effortIds === void 0 ? void 0 : Object.fromEntries(effortIds.filter((effort) => typeof effort === "string" && effort.length > 0).map((effort) => [effort, effort]));
		models.push({
			id,
			...name === void 0 ? {} : { name },
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens },
			...input === void 0 ? {} : { input },
			...reasoningEfforts === void 0 ? {} : { reasoningEfforts }
		});
'@

$llmBefore = @'
			models.push({
				id: model.id,
				...model.name === void 0 ? {} : { name: model.name },
				...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
				...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }
			});
'@
$llmAfter = @'
			models.push({
				id: model.id,
				...model.name === void 0 ? {} : { name: model.name },
				...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
				...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
				...model.input === void 0 ? {} : { input: model.input },
				...model.reasoningEfforts === void 0 ? {} : { reasoningEfforts: model.reasoningEfforts }
			});
'@

$wireBefore = @'
export const discoveredModelViewSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
});
'@
$wireAfter = @'
export const discoveredModelViewSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    input: z.array(z.enum(["text", "image"])).min(1).optional(),
    reasoningEfforts: z.union([z.literal(false), z.record(z.string(), z.string().nullable())]).optional(),
});
'@

$wireBundleBefore = @'
const discoveredModelViewSchema = z$1.object({
	id: z$1.string().min(1),
	name: z$1.string().min(1).optional(),
	contextWindow: z$1.number().int().positive().optional(),
	maxTokens: z$1.number().int().positive().optional()
});
'@
$wireBundleAfter = @'
const discoveredModelViewSchema = z$1.object({
	id: z$1.string().min(1),
	name: z$1.string().min(1).optional(),
	contextWindow: z$1.number().int().positive().optional(),
	maxTokens: z$1.number().int().positive().optional(),
	input: z$1.array(z$1.enum(["text", "image"])).min(1).optional(),
	reasoningEfforts: z$1.union([z$1.literal(false), z$1.record(z$1.string(), z$1.string().nullable())]).optional()
});
'@

$uiBefore = @'
			return {
				id: candidate.id,
				...candidate.name === void 0 ? {} : { name: candidate.name },
				...candidate.contextWindow === void 0 ? {} : { contextWindow: candidate.contextWindow },
				...candidate.maxTokens === void 0 ? {} : { maxTokens: candidate.maxTokens }
			};
'@
$uiAfter = @'
			return {
				id: candidate.id,
				...candidate.name === void 0 ? {} : { name: candidate.name },
				...candidate.contextWindow === void 0 ? {} : { contextWindow: candidate.contextWindow },
				...candidate.maxTokens === void 0 ? {} : { maxTokens: candidate.maxTokens },
				...candidate.input === void 0 ? {} : { input: candidate.input },
				...candidate.reasoningEfforts === void 0 ? {} : { reasoningEfforts: candidate.reasoningEfforts }
			};
'@

$clientWireBefore = @'
		const discoveredModelViewSchema = object({
			id: string().min(1),
			name: string().min(1).optional(),
			contextWindow: number().int().positive().optional(),
			maxTokens: number().int().positive().optional()
		});
'@
$clientWireAfter = @'
		const discoveredModelViewSchema = object({
			id: string().min(1),
			name: string().min(1).optional(),
			contextWindow: number().int().positive().optional(),
			maxTokens: number().int().positive().optional(),
			input: array(_enum(["text", "image"])).min(1).optional(),
			reasoningEfforts: union([literal(false), record(string(), string().nullable())]).optional()
		});
'@

$operations = @(
    @{ Path = $targets[0]; Before = $piAiBefore; After = $piAiAfter }
    @{ Path = $targets[1]; Before = $llmBefore; After = $llmAfter }
    @{ Path = $targets[2]; Before = $wireBundleBefore; After = $wireBundleAfter }
    @{ Path = $targets[3]; Before = $wireBefore; After = $wireAfter }
    @{ Path = $targets[4]; Before = $uiBefore; After = $uiAfter }
    @{ Path = $targets[5]; Before = $clientWireBefore; After = $clientWireAfter }
)

foreach ($operation in $operations) {
    $status = Set-ExactReplacement @operation
    Write-Host "$status $($operation.Path)"
}

if ($CheckOnly) {
    Write-Host 'Check complete; no files were changed.'
} else {
    Write-Host 'Patch complete. Restart dsh web, then fetch and save the models again.'
}
