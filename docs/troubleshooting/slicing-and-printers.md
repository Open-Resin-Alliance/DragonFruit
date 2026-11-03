# Troubleshooting: Slicing, export and printers

Messages you may see while slicing and exporting, importing or exporting LUT curves, opening the output folder, connecting to network printers (NanoDLP/Athena and Elegoo SDCP), sending and starting prints, and using the printer monitor and webcam. When a fix says to report the problem, [Reporting a problem](common-issues.md#reporting-a-problem) lists what to include and where to find the log file. Find the message you're seeing; the fix comes first, and **More detail** has the rest.

## Exporting and opening the output folder

### "Export failed. Check console for details."

<!-- source: src/features/export/components/ExportPanel.tsx -->

The file couldn't be written. Check the models you're exporting are visible and have a mesh (with **Include Model Mesh** on), then export again to a folder like Documents on a disk with free space.

<details>
<summary>More detail</summary>

This shows as an error notice after you click export in the **Export** panel, for any mesh export such as STL, 3MF or `.voxl`, including one file per model or per plate.

The real reason only goes to the developer console, which the desktop app doesn't show. Reasons it can hit include:

- The selected models have no triangle geometry to write ("Cannot export: no triangle geometry found." or "Cannot export 3MF: no triangle geometry found.").
- Writing to the chosen location failed, for example a folder you can't write to or a full disk.

If it still fails, try a different format. Then [report it](common-issues.md#reporting-a-problem) with the steps you took, and mention if only one format fails.

</details>

> [!NOTE]
> **The log file may not have the reason.** This error is logged in the app's internal console, not in the log file, so the log may not show it. Describe the export settings and scope you used in the report.

### "Failed to open directory."

<!-- source: src/components/modals/SliceCompletedModal.tsx -->

DragonFruit couldn't start your file manager. Open the folder yourself: its path is under **File Location** in the **Slicing Finished** window, or **Saved to** in the **Printing** panel.

<details>
<summary>More detail</summary>

You'll see this after clicking **Open Directory** in the **Slicing Finished** window. The same kind of message can appear in the **Printing** panel from the folder button next to the saved file path (its tooltip says **Open file location**).

DragonFruit only checks that the file manager program starts, so you usually see the system's own reason instead of this text:

| Message contains | What it means |
| --- | --- |
| "Failed to open file manager: …" | Linux: DragonFruit opens the file's folder with xdg-open, and xdg-open isn't installed |
| "Failed to open Explorer: …", "Failed to reveal in Finder: …" | Windows or macOS: the system's own file manager program couldn't be started at all |
| "Path is empty" | No file path was recorded for this slice |

On Linux, install xdg-open (part of the xdg-utils package on most distributions) and make sure a file manager is set as the default for folders.

If the button works but no window opens, the file manager started and then failed on its own. DragonFruit doesn't see that, so no message appears. If the folder button is greyed out with the tooltip "Path unavailable", the file wasn't saved to a known location, so there's nothing to open.

If the path is correct and your file manager works, [report it](common-issues.md#reporting-a-problem).

</details>

## LUT curves

### "Unsupported LUT profile format. Use a DragonFruit .lutcurve.json file or a UVTools 256-value .lut/.json LUT array."

<!-- source: src/features/slicing/components/LutCurveEditor.tsx -->

The file is JSON, but not a curve format DragonFruit reads. Re-export the curve from DragonFruit (**Export** in the LUT curve editor) or from UVTools, and import that file.

<details>
<summary>More detail</summary>

This pops up after you click **Import** in the LUT curve editor and pick a file. DragonFruit reads only two formats:

- a DragonFruit curve file (`.lutcurve.json`) exported by DragonFruit, or
- a UVTools LUT: a plain list of exactly 256 numbers.

A list with a different count is rejected, and so is one with an entry that can't be read as a number (a word or an empty value, say). If you edited the file by hand, check a UVTools LUT has exactly 256 values.

</details>

### "Failed to import LUT profile."

<!-- source: src/features/slicing/components/LutCurveEditor.tsx -->

The file isn't valid JSON. Export the curve again from the program that made it and import the new file.

<details>
<summary>More detail</summary>

This pops up after you pick a file to **Import** in the LUT curve editor. You may see the reason itself instead, usually a JSON reading error such as "Unexpected token …" or "JSON Parse error: …".

The file may be damaged, cut short, or a different kind of file renamed to `.json` or `.lut`. Opening it in a text editor will show whether it's complete JSON.

</details>

### "Failed to export LUT curve profile. …"

<!-- source: src/features/slicing/components/LutCurveEditor.tsx -->

The curve file couldn't be written where you chose. Export again to a different folder, such as Documents, and check you have free disk space.

<details>
<summary>More detail</summary>

This pops up after you click **Export** in the LUT curve editor and choose where to save. The desktop app doesn't pass the system's reason on, so the text after the first sentence is usually just "Unknown export error".

If it fails in every folder, [report it](common-issues.md#reporting-a-problem).

</details>

## Connecting to network printers

> [!TIP]
> **Finding Network Settings.** Open the printer profile settings. If the profile has no saved network printer yet, click **Network Settings**. Once a printer is saved, the button reads **Show Fleet**: click it, then click **Manage Fleet**. The window that opens is titled **Network Settings**, or **Fleet Management** when you have more than one printer.

### "No printers found." / "No … printers found on the network."

<!-- source: src/components/printers/PrinterVariantPickerModal.tsx -->

The scan didn't find your printer. Check it's on and shows an IP address on its own screen or web page, then click **Scan again**, or use **Manual IP Entry**: type the address (for example 192.168.1.100) and click **Connect**.

<details>
<summary>More detail</summary>

This follows the network scan under **Auto Detect**. In **Initial Setup** (when you add a printer) it reads "No … printers found on the network.", or "Network scan failed." or a reason from the scan if the scan itself failed. In **Network Settings** you only see "No printers found.".

Common causes:

- The printer is off, still starting up, or not on the network.
- Your computer and the printer are on different networks or subnets (guest Wi-Fi, a VPN, or a mesh network that isolates devices). The scan only checks your local subnet.
- A firewall on your computer blocks DragonFruit's network access. Allow DragonFruit through it, and turn off any VPN while connecting.
- Athena printers don't announce themselves on the network, so DragonFruit has to probe each address in your subnet. This takes a moment.

To skip networking for now in **Initial Setup**, click **Configure Networking Later**.

</details>

### "Couldn't connect to …" / "NanoDLP host unreachable or invalid status payload" / "SDCP host unreachable"

<!-- source: src/components/printers/PrinterVariantPickerModal.tsx -->

DragonFruit got no valid answer from that address. Check the printer's current IP address on its screen and enter it again; if the printer's web page won't load in a browser on this computer either, the problem is the network, not DragonFruit.

<details>
<summary>More detail</summary>

In **Initial Setup** this appears under the list of found printers after you click one. In **Network Settings** (**Manage Fleet**) it appears after you click **Connect**, as a small line under the printer in **Managed Printers**, and the printer is marked **Offline**.

Usual causes:

- The IP address is wrong or has changed (many routers hand out new addresses).
- The printer is off, busy starting up, or not reachable from this computer.
- For NanoDLP/Athena, DragonFruit asks the printer's web server for its status. If something else answers at that address, or the printer's web server isn't running, the reply isn't a valid status.

Restarting the printer and trying again often helps. If your router allows it, give the printer a fixed (reserved) IP address so it doesn't change.

</details>

### "Printer model mismatch: expected …" / "Unsupported printer model. Supported models: Athena, Athena 2."

<!-- source: plugins/athena/rust/network.rs -->

The printer answered, but as a different model than your printer profile. Check you picked the right profile (Athena 2, not Athena, for example) and typed the IP address of the right printer.

<details>
<summary>More detail</summary>

This happens when connecting to a NanoDLP printer. The message may end with 'found "…"', naming the model the printer reported. Only Athena and Athena 2 are supported over NanoDLP; a model DragonFruit doesn't support for this connection gets the "Unsupported printer model" version.

If the printer really is the model you picked, [report it](common-issues.md#reporting-a-problem) with the model name shown in the message.

</details>

### "Could not read printer data."

<!-- source: src/components/printers/PrinterVariantPickerModal.tsx -->

DragonFruit connected but couldn't read the data it uses to tell printer variants apart. Once the printer has finished starting up, click it again in the list; if that doesn't help, update the printer's firmware or add it without detection (below).

<details>
<summary>More detail</summary>

This appears in **Initial Setup**, after DragonFruit connects and tries to detect the exact model. A reason from the printer may show instead, such as "HTTP 404" or "Invalid printer data payload". Older printer firmware may not provide this data.

To add the printer without detection:

1. Click **Cancel**, and turn the printer off or disconnect it from the network.
2. Start adding the printer again with **Auto Detect**.
3. When the scan finds no printers, click **Configure Networking Later** and pick your variant by hand.
4. Turn the printer back on and connect it afterwards in **Network Settings** (**Manage Fleet**).

</details>

### "Detected a … screen that doesn't match any known variant of …"

<!-- source: src/components/printers/PrinterVariantPickerModal.tsx -->

The screen bit depth the printer reported doesn't match any variant of the printer family you chose. Check you chose the right family, or pick the variant by hand (below).

<details>
<summary>More detail</summary>

This appears in **Initial Setup**, after the printer reports its screen bit depth; DragonFruit picks the variant from that value. "Detected a ? screen" means the printer didn't report a bit depth.

To pick the variant by hand, click **Cancel**, turn the printer off or disconnect it from the network, and start adding the printer again with **Auto Detect**. When the scan finds no printers, click **Configure Networking Later** and choose the variant. Connect the printer afterwards in **Network Settings** (**Manage Fleet**).

If your printer is the family you chose, [report it](common-issues.md#reporting-a-problem) with the bit depth shown in the message.

</details>

## Printer offline

### "This machine is currently offline"

<!-- source: src/components/organisms/modals/PrintingModals.tsx -->

DragonFruit can't reach the printer right now. Check it's on and on the network, then click **Open Network Settings** and the connect button next to the printer under **Managed Printers**.

<details>
<summary>More detail</summary>

This replaces the printer's status in the printer monitor, with the body "Reconnect this printer in Network Settings, or choose a different online printer from the selector above." Other signs of the same state:

- "… is offline" as the tooltip of a printer card on the **Monitoring Dashboard**. Offline cards can't be opened.
- "Selected printer is offline" as the tooltip of the **Monitor** button in the top bar.
- **Offline** next to a printer's IP address in printer lists.

The printer didn't answer its last status check, or was never connected in this session. Common causes are the printer being off or asleep, a changed IP address, or a network problem between the computer and the printer. If the IP address changed, add the printer again with its new address. If you have several printers, you can pick an online one from the printer selector at the top of the monitor.

</details>

### "Printer is responding slowly"

<!-- source: src/components/organisms/modals/PrintingModals.tsx -->

The printer has stopped answering for now, often because it's busy (processing a file, say). Wait for the countdown; if it answers, the monitor goes back to normal.

<details>
<summary>More detail</summary>

The body reads "We will keep trying to reconnect for another …s. If reconnection fails, please verify the network configuration and confirm the printer is online."

The printer answered a status check recently, and DragonFruit waits a grace period (30 seconds by default) before showing it as offline. If it then shows "This machine is currently offline", follow that entry.

</details>

### "Selected printer is offline. Choose an online printer to continue."

<!-- source: src/components/organisms/modals/PrintingModals.tsx -->

The target printer can't be reached right now. Pick a printer marked **Online**, or reconnect this one in **Network Settings** (**Manage Fleet**) and try again.

<details>
<summary>More detail</summary>

This shows under the list of printers in the **Fleet Upload** or **Pre-Slice Targeting** window. Offline printers are greyed out and marked **Offline**. For reconnecting, see "This machine is currently offline".

</details>

## Slicing for a network printer

### "Remote material unavailable." / "Network unavailable."

<!-- source: src/features/slicing/components/SlicingPanel.tsx -->

DragonFruit can't read the printer's material, so it can't take the layer height from it. To slice anyway, type the layer height of the material you'll print with in the **Offline Layer Height** box (in micrometres, 10 to 1000).

<details>
<summary>More detail</summary>

This appears in an **Offline Layer Height** box in the **Slicing** panel; the full text is "Network unavailable. Select a matching material during import instead." Your printer profile uses material profiles stored on the printer (NanoDLP/Athena), and the printer isn't connected or reachable.

When you upload later, pick a material on the printer with the same layer height. Or reconnect the printer in **Network Settings** (**Manage Fleet**) so DragonFruit can read its materials.

</details>

### "No material on this printer matches sliced layer height … mm." / "No matching material profile found on this printer."

<!-- source: src/features/printing/usePrintingMonitorManager.ts -->

None of the printer's materials has the layer height you sliced with. Slice again with the layer height of a material already on the printer, or create or edit one with that layer height in the printer's web interface, then restart DragonFruit and upload again.

<details>
<summary>More detail</summary>

This appears in the **Fleet Upload** window, under **Target material (matching sliced layer height)**. In **Pre-Slice Targeting** it reads "No material profiles found on this printer." Related messages in the upload window:

- "Selected material on this printer does not match sliced layer height … mm."
- "Select a matching material profile before upload."

For NanoDLP/Athena, each upload is tied to a material profile stored on the printer, and its layer height must match the one you sliced with. The message also shows when no material is selected, or when the printer answers the material request with an error, because DragonFruit then gets an empty list. If the request can't be made at all, the error text shows in place of this message.

If the printer does have a matching material, check it's online, then restart DragonFruit and try again.

</details>

> [!NOTE]
> **Restart after changing materials on the printer.** DragonFruit reads a printer's material list once per session and keeps it. Changes you make on the printer, or a list that came back empty because of an error, are only picked up after you restart DragonFruit.

## Sending and starting prints

### "Send failed: …"

<!-- source: src/app/page.tsx -->

The file didn't reach the printer, or the printer refused it. Check the printer is on and shows as online, then click **Retry Upload**.

<details>
<summary>More detail</summary>

This appears in the upload window after you click **Upload to …** (or **Upload to Selected Printer**), with the stage "Upload failed". The text after "Send failed:" is the reason:

| Message contains | What it means |
| --- | --- |
| "error sending request for url (…)" | DragonFruit couldn't reach the printer during the upload: it went offline, its IP address changed, or the network dropped |
| "HTTP" and a number, such as "HTTP 500" | The printer got the request but refused it. On NanoDLP this can mean it's busy, out of storage, or doesn't accept the file or material |
| "SDCP upload chunk failed (HTTP …)" | An Elegoo printer refused part of the file |
| "Network operation timed out" | The upload took longer than DragonFruit allows (10 minutes for a NanoDLP upload) |
| "Network error during upload" | The connection broke during the transfer |
| "Lost connection while waiting for device processing." | The upload finished, but the printer stopped answering while it processed the file |
| "Failed to open upload file …", "Failed to read SDCP upload chunk from native file path." | DragonFruit couldn't read the sliced file from its temporary folder; it may have been removed, or the disk may be full |

What to try for each:

- For an "HTTP …" reason, check on the printer's own web page or screen that it's idle and has free storage, and delete old files from it if needed.
- For a timeout on a large file, move the printer or computer closer to the router, or use a wired connection, and try again.
- If the sliced file couldn't be read, slice again and upload the new file.

If you cancelled the upload yourself, you see "Upload canceled. You can retry when ready." instead. If the same reason keeps appearing, [report it](common-issues.md#reporting-a-problem) with the full message.

</details>

### "No printer IP address available for send operation." / "No connected printer is available for upload."

<!-- source: src/app/page.tsx -->

The printer profile has no connected printer, or the saved printer has no IP address. Connect the printer in **Network Settings** (**Manage Fleet**) for that profile, then try the upload again.

<details>
<summary>More detail</summary>

This appears in the upload window or the **Printing** panel when you try to upload. Clicking **Start Print** can give a similar "No printer IP address available for Print Now.". If connecting fails, see "Couldn't connect to …".

</details>

### "Upload complete. Device is still processing metadata after waiting."

<!-- source: src/app/page.tsx -->

The file did upload; the printer is just slow to prepare it. Check the printer's own screen or web page, and once the file is ready, start the print from there or from the file list in the DragonFruit printer monitor.

<details>
<summary>More detail</summary>

This appears in the upload window with the stage "Device still processing", and may include the plate number. DragonFruit waited 10 minutes and the printer still hadn't finished; very large files can take that long. The file is usually on the printer and may finish processing on its own.

</details>

### "Print start failed: …"

<!-- source: src/app/page.tsx -->

The printer didn't accept the start command. Check it's idle, the build plate and vat are in place and its screen shows no error, then click **Start Print** again.

<details>
<summary>More detail</summary>

This appears in the upload window after you click **Start Print**, with the stage "Start print failed". The reason after the colon is usually one of:

| Message contains | What it means |
| --- | --- |
| "HTTP" and a number | A NanoDLP printer refused the command, for example because it's already printing or the plate no longer exists |
| "SDCP printer/start failed." | An Elegoo printer didn't confirm the command, including when it doesn't answer in time |
| "Unable to resolve SDCP mainboard ID for control command." | DragonFruit couldn't identify the Elegoo printer on the network to send the command to. Reconnect it in **Network Settings** (**Manage Fleet**) and try again |
| "error sending request for url (…)" | The printer couldn't be reached |

If it still fails, start the uploaded file from the printer's own screen, or from the file list in the DragonFruit printer monitor.

</details>

## Printer monitor and webcam

### "The webcam image could not be loaded."

<!-- source: src/components/organisms/modals/PrintingModals.tsx -->

DragonFruit couldn't get a picture from the printer's camera. Click **Retry**, and check the camera works in the printer's own web interface or app. If your printer has no camera, you can ignore this.

<details>
<summary>More detail</summary>

This shows in the webcam area of the printer monitor, under the title "Webcam Unavailable". The camera may be off, unplugged, busy, or not reachable over the network. Other messages in the same place:

| Message | What it means |
| --- | --- |
| "Webcam stream stalled. Retrying (…)…" | The stream stopped; DragonFruit retries it twice by itself |
| "The webcam stream did not deliver any video data in time.", "RTSP relay websocket disconnected." | The video stream from the printer stopped or never started |
| "Webcam timed out … times in a row. Auto-retries are paused to prevent request spam. Click Retry Webcam to try again." | The printer didn't answer webcam requests 3 times in a row. The button to use is **Retry** |
| "No camera endpoint available from this printer.", "No webcam endpoint reported by this printer." (under "Webcam Not Ready") | The printer didn't report a camera |

If **Reset stream slot** is shown (the title is then "Video Stream Busy"), the printer has reached its limit of video streams. Close other apps or browser tabs showing the camera, or click **Reset stream slot**, then **Retry**.

</details>
