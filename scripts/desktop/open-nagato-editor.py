"""Open the user's editable model in the existing PSD2Live Windows GUI."""

import ctypes
import subprocess
import sys
from pathlib import Path
from time import monotonic, sleep


def main():
    editor, project = (Path(argument).resolve(strict=True) for argument in sys.argv[1:])
    import mcp_proxy
    from mcp_proxy import Client, McpError, get_token

    user32 = ctypes.windll.user32
    user32.FindWindowW.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p)
    user32.FindWindowW.restype = ctypes.c_void_p
    user32.ShowWindow.argtypes = (ctypes.c_void_p, ctypes.c_int)
    user32.SetForegroundWindow.argtypes = (ctypes.c_void_p,)

    def get_workspace():
        if not get_token():
            return None
        try:
            with Client(endpoint=mcp_proxy.get_endpoint(), timeout=1.25) as client:
                return client.project()
        except McpError:
            return None

    workspace = get_workspace()
    if workspace is None:
        subprocess.Popen([str(editor), '--lang', 'zh'], cwd=editor.parent)
        deadline = monotonic() + 25
        while monotonic() < deadline and workspace is None:
            sleep(0.3)
            workspace = get_workspace()
    if workspace is None:
        raise RuntimeError('请在 PSD2Live 中选择「文件 → 打开工程」，然后打开：\n' + str(project))

    # A separate shortcut is safe to click while editing a different model.
    # PSD2Live's normal Open command protects that workspace's unsaved edits.
    if not workspace['loaded']:
        with Client(endpoint=mcp_proxy.get_endpoint(), timeout=25) as client:
            client.edit('project_open', path=str(project), discard_unsaved=False)
    title = 'PSD2Live — ' + str(project)
    window = user32.FindWindowW(None, title) or user32.FindWindowW(None, title + ' *')
    if window:
        user32.ShowWindow(window, 9)
        user32.SetForegroundWindow(window)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        ctypes.windll.user32.MessageBoxW(None, str(error), 'PSD2Live', 0x10)
        sys.exit(1)
