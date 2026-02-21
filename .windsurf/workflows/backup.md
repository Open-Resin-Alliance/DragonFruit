This document is intended to act as a set of instructions for creating a backup of the STL Slicer / AutoSupport project. You dont need confirmation from the user before following these directions. 

You will first read the first 200 lines of the `2_Backup\00. Changelog.md` file. Then you will create a new entry in that file based on the directions in the heading of the file. 

Then make sure to read and update 1. Documentation\ARCHITECTURE_AND_HANDOFF.md. This document is generally our bible of actual logic and directory structure for the app.

After the entry, you will run the backup script. The script is located at `2_Backup\0. create-backup.ps1`. The script will create a new backup folder in the `2_Backup\Backups` directory. The folder will be named v1, v2, v3 etc. based on the number of existing backup folders. The script will then copy all files from the AutoSupport project to the new backup folder, excluding the `node_modules` and `2_Backup` folders. 

Please use this exact powershell command:  `& ".\2_Backup\0. create-backup.ps1"`