import { spawn } from 'node:child_process';

// Errors carry a code so the Player UI shows it instead of LOCAL_APP_REQUEST_FAILED.
const pickerError = code => Object.assign(new Error(code), { code });

const windowsScript = `Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'MTM PLAYER: select the installed team workspace'
$dialog.ShowNewFolderButton = $false
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'MTM PLAYER — Select workspace'
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
try {
  $owner.Show()
  $owner.Activate()
  $owner.BringToFront()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
} finally {
  $dialog.Dispose()
  $owner.Close()
  $owner.Dispose()
}`;

// `activate` brings the osascript dialog in front of the browser; Cancel exits 1 with error -128.
const macScript = ['activate',
  'POSIX path of (choose folder with prompt "MTM PLAYER: select the installed team workspace")'];

function pickerCommand(platform) {
  if (platform === 'win32') return { command: 'powershell.exe',
    args: ['-NoLogo','-NoProfile','-STA','-EncodedCommand',Buffer.from(windowsScript,'utf16le').toString('base64')],
    cancelled: () => false };
  if (platform === 'darwin') return { command: 'osascript',
    args: macScript.flatMap(line => ['-e', line]),
    cancelled: (code, stderr) => code === 1 && /-128\b/.test(stderr) };
  // Ubuntu desktops ship zenity; Cancel or closing the dialog exits 1.
  if (platform === 'linux') return { command: 'zenity',
    args: ['--file-selection', '--directory', '--title=MTM PLAYER: select the installed team workspace'],
    cancelled: code => code === 1, missing: 'FOLDER_PICKER_UNAVAILABLE' };
  return null;
}

// A native dialog selects a path only; it never uploads or initializes a match.
export function browseTeamWorkspace({ platform = process.platform, spawnImpl = spawn } = {}) {
  const picker = pickerCommand(platform);
  if (!picker) return Promise.reject(pickerError('FOLDER_PICKER_UNSUPPORTED_PLATFORM'));
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(picker.command, picker.args, { windowsHide:true, shell:false, stdio:['ignore','pipe','pipe'] }); }
    catch { reject(pickerError('FOLDER_PICKER_FAILED')); return; }
    let output=''; let errors=''; let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value)};
    const timer=setTimeout(()=>{child.kill();finish(pickerError('FOLDER_PICKER_TIMEOUT'))},120000);
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>32768){child.kill();finish(pickerError('FOLDER_PICKER_FAILED'))}});
    child.stderr.on('data',chunk=>{if(errors.length<4096)errors+=chunk.toString()});
    // Without zenity the operator can still type the workspace path.
    child.once('error',error=>finish(pickerError(error?.code==='ENOENT'&&picker.missing||'FOLDER_PICKER_FAILED')));
    child.once('exit',code=>{
      if (code === 0) {
        // macOS returns folders with a trailing slash; keep the root as-is.
        const selected = output.trim().replace(/(.)\/+$/, '$1');
        finish(null, selected || null);
      } else if (picker.cancelled(code, errors)) finish(null, null);
      else finish(pickerError('FOLDER_PICKER_FAILED'));
    });
  });
}
