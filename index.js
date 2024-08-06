const { timingSafeEqual } = require('crypto');
const fs = require('fs');
const { inspect } = require('util');
const { utils: { generateKeyPairSync } } = require('ssh2');
const { utils: { parseKey }, Server } = require('ssh2');
const ssh2 = require('ssh2')
const figlet = require('figlet');
const fetch = require('node-fetch');
const chalk = require('chalk');
ssh2.createAgent("pageant")

var instanceName = "server"



let fileSystem = {}
let users = []

function formatMilliseconds(ms, short = false) {
    let seconds = Math.floor(ms / 1000);
    let minutes = Math.floor(seconds / 60);
    let hours = Math.floor(minutes / 60);

    seconds %= 60;
    minutes %= 60;

    let result = [];
    if (hours > 0) {
        result.push(hours + (short ? " h " : " hour" + (hours > 1 ? "s" : "")));
    }
    if (minutes > 0) {
        result.push(minutes + (short ? " m" : " minute" + (minutes > 1 ? "s" : "")));
    }
    if (seconds > 0 || result.length === 0) {
        result.push(seconds + (short ? "s " : " second" + (seconds > 1 ? "s" : "")));
    }

    return result.join(" and ");
}


const fileSystemFunctions = {
    createFile: function (userDB, path, content = '',) {
        const parentDir = navigateToPath(path, true);
        parentDir[getFileName(path)] = { content: content, owner: userDB.uid, lastModified: new Date(), created: new Date(), type: 'file' };
        userDB.stats.files++;
    },
    createDirectory: function (userDB, path) {
        const parentDir = navigateToPath(path, true);
        parentDir[getFileName(path)] = { owner: userDB.uid, lastModified: new Date(), created: new Date(), type: 'directory', content: {} };
        userDB.stats.directories++;
    },
    changeFileContent: function (path, content) {
        const file = navigateToPath(path);
        if (typeof file === 'string') {
            navigateToPath(path, true)[getFileName(path)].content = content;
            navigateToPath(path, true)[getFileName(path)].lastModified = new Date();
            navigateToPath(path, true)[getFileName(path)].size = content.length;

        } else {
            throw new Error('Path not found');
        }
    },
    remove: function (path) {
        const parentDir = navigateToPath(path, true);
        delete parentDir[getFileName(path)];
    },
    getBashHistory: function (userDB) {
        return this.readFileContent(`${userDB.home}/.bash_history`) || '';
    },
    addToBashHistory: function (userDB, command) {
        var history = this.getBashHistory(userDB);
        history += command + '\n';
        this.changeFileContent(`${userDB.home}/.bash_history`, history);
    },
    tree: function (path, indent = '') {
        let treeOutput = '';
        const target = navigateToPath(path, false, false);
        console.log(path, target)
        if (target.type !== 'directory') {
            throw new Error('Path not found');
        }
        for (const [key, value] of Object.entries(target.content)) {
            const isLast = Object.keys(target.content).indexOf(key) === Object.keys(target.content).length - 1;
            treeOutput += indent + (isLast ? '└── ' : '├── ') + key + '\n';
            if (value.type === 'directory') {
                treeOutput += this.tree(`${path}/${key}`, indent + (isLast ? '    ' : '│   '));
            }
        }


        return treeOutput;
    },
    readFileContent: function (path) {
        const file = navigateToPath(path);
        if (typeof file === 'string') {
            return file;
        } else {
            return false;
        }
    },
    copy: function (source, destination) {
        const sourceObj = navigateToPath(source, true);
        if (sourceObj === false) {
            throw new Error('Source path not found');
        }
        console.log("Surce", sourceObj)
        const destinationDir = navigateToPath(destination, true);
        if (destinationDir === false) {
            throw new Error('Destination path not found');
        }

        destinationDir[getFileName(destination)] = JSON.parse(JSON.stringify(sourceObj[getFileName(source)]));
    },
    move: function (source, destination) {
        this.copy(source, destination);
        this.remove(source);
    },
};



function navigateToPath(path, parent = false, content = true) {
    const parts = path.split('/').filter(part => part.length > 0);
    let current = fileSystem['/']
    if (!content && parts.length === 0) {
        return current;
    } else {
        current = current.content;
    }
    for (let i = 0; i < (parent ? parts.length - 1 : parts.length); i++) {
        let c = current[parts[i]]

        if (c === undefined) {
            return false;
        }

        if (content && i === parts.length - 1) {
            current = c.content;
        } else if (!content && i === parts.length - 1) {
            return c;
        } else {
            current = c.content;
        }
    }
    return current;
}

function getFileName(path) {
    const parts = path.split('/');
    return parts[parts.length - 1];
}

function parseCommand(command) {
    const parts = command.split(' ');
    const result = {};
    let input = "";

    for (let i = 0; i < parts.length; i++) {
        if (parts[i].startsWith('-')) {
            const arg = parts[i].substring(1);
            const value = parts[i + 1];
            result[arg] = value;
            i++;
        } else if (i === parts.length - 1) {
            input = parts[i];
        }
    }

    if (input) {
        result['input'] = input;
    }

    return result;
}


const db = require('./db');
const { create } = require('domain');
const { exec } = require('child_process');

const key = generateKeyPairSync('rsa', {
    bits: 2048
});

let hostKey;
try {
    hostKey = fs.readFileSync('host.key');
} catch (err) {
    if (err.code !== 'ENOENT') {
        throw err;
    }
}

if (hostKey) {
    key.private = hostKey;
} else {
    console.log('Host key not found, generating a new one');
    fs.writeFileSync('host.key', key.private);
}

const server = new Server({
    hostKeys: [key.private]
}, (client) => {
    console.log('Client connected!');
    let authCtx = {}
    let PTY = {}

    /**
     * @type {Object}
     * @property {string} username
     * @property {string} password
     * @property {string} shell
     * @property {string} home
     * @property {number} uid
     * @property {Object} stats
     * @property {Object} stats.commands
     * @property {number} stats.files
     * @property {number} stats.directories
     * @property {number} stats.sudo
     * @property {number} stats.uptime
     */
    var start = new Date()
    var userDB = {
        username: '',
        password: '',
        home: '',
        uid: 0,
        groups: [],
        stats: {
            commands: {},
            files: 0,
            directories: 0,
            sudo: 0,
            uptime: 0,
            lastLogin: new Date()
        }
    };

    var tries = 0;

    var lastUser = 0;
    var hystoryPosition = 0;

    let tabMachPosition = 0;
    let tabMachCommandPosition = 0;
    let first = true;
    let firstFile = true;

    let inputPosition = 0;

    var hinput,
        command,
        commandList,
        fileListing,
        fileNames,
        matchingCommands,
        matchingFiles

    let currentDir = '/';
    let sudoLogin = false; // logged in as root at least once
    let mode = 'normal';
    const commands = [
        {
            name: 'help',
            description: 'List all available commands',
            root: false,
            execute: function () {
                var output = 'Available commands:\r\n';

                commands.sort((a, b) => a.name.localeCompare(b.name)).forEach(command => {
                    var descriptionLines = []
                    var description = command.description;
                    while (description.length > PTY.cols - 10) {
                        descriptionLines.push(description.slice(0, PTY.cols - 10));
                        description = description.slice(PTY.cols - 10);
                    }

                    descriptionLines.push(description);
                    output += `${command.name.padEnd(10)}${descriptionLines[0]}\r\n`;
                    descriptionLines.slice(1).forEach(line => {
                        output += ' '.repeat(10) + line + '\r\n';
                    })
                })

                console.log(output)
                return output;

            }
        },
        {
            name: "clear",
            description: "Clear the screen",
            root: false,
            execute: function () {
                return '\x1Bc';
            }
        },
        {
            name: 'date',
            description: 'Display the current date and time',
            root: false,
            execute: function () {
                return new Date().toLocaleString() + '\r\n';
            }
        },
        {
            name: "touch",
            description: "Create a new file",
            root: false,
            execute: function (input) {
                const fileName = input.split(' ')[1];
                if (fileName) {
                    fileSystemFunctions.createFile(userDB, `${currentDir}/${fileName}`, fileName == "grass.txt" ? "Time to go outside :)" : "");
                    return '';
                } else {
                    return 'touch: missing file operand\r\n';
                }
            }
        },
        {
            name: 'rm',
            root: false,
            description: 'Delete a file or directory',
            execute: function (input) {
                const path = input.split(' ')[1];
                try {
                    var target = navigateToPath(`${path}`) || navigateToPath(`${currentDir}/${path}`);
                    if (target) {
                        if (target.type === 'directory') {
                            delete navigateToPath(`${path}`, true)[getFileName(path)];
                        } else {
                            delete navigateToPath(`${path}`, true)[getFileName(path)];
                        }
                    } else {
                        return `rm: ${path}: No such file or directory\r\n`;
                    }

                    return '';
                } catch (error) {
                    return `rm: ${path}: ${error.message}`;
                }
            }
        },
        {
            name: 'cat',
            root: false,
            description: 'Display the content of a file',
            execute: function (input) {
                const fileName = input.split(' ')[1];
                if (!fileName) {
                    return 'cat: missing file operand\r\n';
                }
                try {
                    var target = fileSystemFunctions.readFileContent(`${fileName}`) || fileSystemFunctions.readFileContent(`${currentDir}/${fileName}`);
                    console.log(target)
                    var content = "";
                    if (target === false || target === undefined || target.type === 'directory') {
                        return `cat: ${fileName}: No such file or directory\r\n`;
                    } else {
                        content = target
                    }

                    return content + '\r\n';
                } catch (error) {
                    console.log(error)
                    return `cat: ${fileName}: No such file or directory\r\n`;
                }
            }
        },
        {
            name: 'echo',
            root: false,
            description: 'Print text to the terminal',
            execute: function (input) {
                var parts = input.split(' ');
                if (parts[parts.length - 2] === '>') {
                    parts.pop();
                    parts.pop();
                }
                parts.shift();
                return parts.join(' ') + '\r\n';
            }
        },
        {
            name: 'ls',
            root: false,
            description: 'List files and directories',
            execute: function (input) {
                var params = input.split(' ')
                var currentDirContent = navigateToPath(currentDir);
                if (params[2]) {
                    var target = navigateToPath(`${params[2]}`);
                    if (!target) target = navigateToPath(`${currentDir}/${params[2]}`);
                    if (target) currentDirContent = target;
                } else if (params[1]) {
                    var target = navigateToPath(`${params[1]}`);
                    if (!target) target = navigateToPath(`${currentDir}/${params[1]}`);
                    if (target) currentDirContent = target;
                }
                if (params[1] == "-la") {
                    var output = 'total ' + Object.keys(currentDirContent).length + '\r\n';
                    Object.keys(currentDirContent).forEach((key) => {
                        var size = 0;
                        if (currentDirContent[key].type == 'file') {
                            size = currentDirContent[key].content.length;
                        } else {
                            size = Object.keys(currentDirContent[key].content).length;
                        }
                        output += `${currentDirContent[key].type == 'directory' ? 'd' : '-'}rwxr-xr-x 1 ${currentDirContent[key].owner}${" ".repeat(7 - currentDirContent[key].owner.toString().length)}${currentDirContent[key].owner}${" ".repeat(7 - currentDirContent[key].owner.toString().length)}${size.toString().padStart(7)} ${currentDirContent[key].lastModified.toLocaleString()} ${currentDirContent[key].type == 'directory' ? "\x1B[34m" : ""}${key}${currentDirContent[key].type == 'directory' ? "\x1B[0m" : ""}\r\n`;
                    });
                    return output;
                } else {
                    return Object.keys(currentDirContent).map((key) => (currentDirContent[key].type == 'directory' ? "\x1B[34m" : "") + key + (currentDirContent[key].type == 'directory' ? "\x1B[0m" : "")).join(' ') + '\r\n';
                }

            },
        },
        {
            name: "mkdir",
            description: "Create a new directory",
            root: false,
            execute: function (input) {
                const dirName = input.split(' ')[1];
                if (dirName) {
                    fileSystemFunctions.createDirectory(`${currentDir}/${dirName}`);
                    return '';
                } else {
                    return 'mkdir: missing operand\r\n';
                }
            }
        },
        {
            name: "mv",
            description: "Move a file or directory",
            root: false,
            execute: function (input) {
                const parts = input.split(' ');
                if (parts.length < 3) {
                    return 'mv: missing operand\r\n';
                }
                try {
                    var source = navigateToPath(`${parts[1]}`);
                    if (!source) source = navigateToPath(`${currentDir}/${parts[1]}`);
                    var destination = navigateToPath(`${parts[2]}`);
                    if (!destination) destination = navigateToPath(`${currentDir}/${parts[2]}`);
                    if (!source) {
                        return `mv: cannot stat '${parts[1]}': No such file or directory\r\n`;
                    }
                    if (destination && destination.type === 'directory') {
                        destination.content[getFileName(parts[1])] = source;
                        delete navigateToPath(`${parts[1]}`, true)[getFileName(parts[1])];
                    } else {
                        return `mv: cannot move '${parts[1]}' to '${parts[2]}': Not a directory\r\n`;
                    }
                    return '';
                } catch (error) {
                    return `mv: ${error.message}\r\n`;
                }
            }
        },
        {
            name: "cp",
            description: "Copy a file or directory",
            root: false,
            execute: function (input) {
                const parts = input.split(' ');
                if (parts.length < 3) {
                    return 'cp: missing operand\r\n';
                }
                try {
                    var source = navigateToPath(`${parts[1]}`);
                    if (!source) source = navigateToPath(`${currentDir}/${parts[1]}`);
                    var destination = navigateToPath(`${parts[2]}`);
                    if (!destination) destination = navigateToPath(`${currentDir}/${parts[2]}`);
                    if (!source) {
                        return `cp: cannot stat '${parts[1]}': No such file or directory\r\n`;
                    }
                    if (destination && destination.type === 'directory') {
                        destination.content[getFileName(parts[1])] = source;
                    } else {
                        return `cp: cannot copy '${parts[1]}' to '${parts[2]}': Not a directory\r\n`;
                    }
                    return '';
                } catch (error) {
                    return `cp: ${error.message}\r\n`;
                }
            }
        },
        {
            name: "cd",
            description: "Change the current directory",
            root: false,
            execute: function (input) {
                var directoryName = input.split(' ')[1];

                try {
                    let newDir;
                    if (directoryName == ".." || directoryName == "../") {
                        newDir = currentDir.substring(0, currentDir.lastIndexOf('/')) || '/';
                    } else if (directoryName == "~") {
                        newDir = userDB.home;
                    } else if (directoryName.startsWith("/")) {
                        newDir = directoryName;
                    } else {
                        newDir = `${currentDir}/${directoryName}`.replace("//", "/");
                    }
                    console.log(newDir, navigateToPath(newDir, false, false).type)
                    if (navigateToPath(newDir, false, false).type === 'directory') {
                        currentDir = newDir;
                        return '';
                    } else {
                        return `cd: ${directoryName}: No such file or directory\r\n`;
                    }

                } catch (error) {
                    return `cd: ${directoryName}: No such file or directory\r\n`;
                }
            }
        },
        {
            name: "exit",
            description: "Exit the terminal",
            root: false,
            execute: function (input, currentUser, shell) {
                if (userDB.uid != 0 && lastUser != 0) {
                    shell.write('Bye!\x1B[0m\r\n');
                    shell.end();
                } else {
                    userDB = users.find(user => user.uid === lastUser);
                }
                return '';
            }
        },
        {
            name: "pwd",
            root: false,
            description: "Print the current working directory",
            execute: function () {
                return currentDir + '\r\n';
            }
        },
        {
            name: "whoami",
            root: false,
            description: "Display the current user",
            execute: function (input, currentUser) {
                return users.find(user => user.uid === currentUser).username + '\r\n';
            }
        },
        {
            name: "su",
            description: "Change user",
            root: false,
            execute: function (input, currentUser, shell) {
                var user = input.split(' ')[1];

                var dbuser = users.find(u => u.username === user);
                if (!user) dbuser = users.find(user => user.uid === 0);
                console.log(user, dbuser)
                if (!dbuser) {
                    return `su: user '${user}' does not exist\r\n`;
                }

                if (dbuser.password == "") {
                    userDB = dbuser;
                    if (userDB.uid != 0) {
                        lastUser = userDB.uid;
                    }
                    return '';
                } else {
                    mode = "supassword-" + dbuser.username;
                    tries = 0
                    shell.write('Password: ');
                    return false;
                }

            }
        },
        {
            name: "curl",
            description: "Fetch a file from the internet",
            root: false,
            execute: function (input, currentUser, shell) {
                var url = input.split(' ')[1];
                if (!url) {
                    return 'curl: missing URL operand\r\n';
                }
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = 'http://' + url;
                }
                mode = "waiting";
                fetch(url, {
                    headers: {
                        "User-Agent": "curl/7.68.0"
                    }
                }).then(response => response.text()).then(body => {
                    body.split('\n').forEach((line, index) => {
                        shell.write(line + '\r\n');
                    });
                    mode = "normal";
                    shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                }).catch(error => {
                    shell.write(`curl: ${error.message}\r\n`);
                    mode = "normal";
                    shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                });
                return false;
            }
        },
        {
            name: "neofetch",
            description: "Display system information",
            root: false,
            execute: function (input, currentUser, shell) {
                let first = users.find(user => user.uid === currentUser).username + "@" + instanceName
                let infos = [first, "-".repeat(first.length), "OS: ExelviOS", "Kernel: 5.4.0-80-generic", "Uptime: " + formatMilliseconds(new Date() - start), "Shell: bash", "Terminal: " + PTY.term]
                let asciiArt = figlet.textSync('E', { font: 'Colossal' });
                asciiArt = asciiArt.split("\n").map((line, index) => {
                    if (infos[index]) {

                        return line + " ".repeat(10) + (index == 1 || index == 0 ? "\x1B[32m" : "\x1B[34m") + infos[index] + "\x1B[0m\r\n";
                    } else {
                        return line + "\r\n";
                    }
                }).join("\n");
                return asciiArt;

            }
        },
        {
            name: "usermod",
            description: "Modify user account",
            root: false,
            execute: function (input, currentUser, shell) {
                var inputParsed = parseCommand(input);

                if (input.includes('--help') || input.includes('-h')) {
                    var output = `Usage: usermod [options] LOGIN

Options: 

  -d, --home HOME_DIR           new home directory for the user account
  -h, --help                    display this help message and exit
  -l, --login NEW_LOGIN         new value of the login name
  -m, --move-home               move contents of the home directory to the

`;
                    var outputFinal = ""
                    output.split("\n").forEach((line, index) => {
                        outputFinal += line + "\r\n";
                    })
                    return outputFinal;
                }

                if (inputParsed['l'] || inputParsed['-login']) {
                    var user = inpudParsed['input'];
                    if (user == undefined || user == "") {
                        user = users.find(user => user.uid === currentUser).username;
                    }
                    if (!users.find(user => user.username === user)) {
                        return `usermod: user '${user}' does not exist\r\n`;
                    }
                    if (userDB.uid == user) {
                        return `usermod: user '${user}' is currently used by process 1097\r\n`;
                    } else if (users.find(u => u.name == user).UID === 0) {
                        return `usermod: user '${user}' is currently used by process 1\r\n`;
                    } else {
                        users.find(user => user.username === user).username = inputParsed['l'] || inputParsed['-login'];
                        return '';
                    }
                }

                if (inputParsed['d'] || inputParsed['-home']) {
                    var user = inputParsed['input'];
                    if (user === undefined || user === "") {
                        user = users.find(user => user.uid === currentUser).username;
                    }
                    if (settings.users.find(u => u.name == user)?.UID === 0) {
                        return `usermod: user '${user}' is currently used by process 1\r\n`;
                    } else if (!users.find(user => user.username === user)) {
                        return `usermod: user '${user}' does not exist\r\n`;
                    }

                    if (inputParsed['m'] || inputParsed['-move-home']) {
                        fileSystemFunctions.move(users.find(user => user.username === user).home, inputParsed['d'] || inputParsed['-home']);
                    }
                    users.find(user => user.username === user).home = inputParsed['d'] || inputParsed['-home'];
                }
            }
        },
        {
            name: "passwd",
            description: "Change user password",
            root: false,
            execute: function (input, currentUser, shell) {
                var inputParsed = parseCommand(input);

                if (input.includes('--help') || input.includes('-h')) {
                    return `Usage: passwd [options] LOGIN`
                }

                var user = input.split(' ')[1];
                if (user === undefined || user === "") {
                    user = users.find(user => user.uid === currentUser).username;
                }

                if (!users.find(u => u.username === user)) {
                    return `passwd: user '${user}' does not exist\r\n`;
                }

                if (currentUser != 0) {
                    mode = "passwd-c-" + user;
                    shell.write('Current password: ');
                    tries = 0;
                    return false;
                } else {
                    mode = "passwd-n-" + user;
                    shell.write('New password: ');
                    tries = 0;
                    return false;
                }
            }
        },
        {
            name: 'adduser',
            description: 'Create a new user',
            root: true,
            execute: function (input, currentUser, shell) {
                var user = input.split(' ')[1];
                if (input.includes('--help') || input.includes('-h') || user === undefined || user === "") {
                    return `Usage: adduser LOGIN\r\n`
                }

                if (users.find(u => u.username === user)) {
                    return `adduser: user '${user}' already exists\r\n`;
                }

                shell.write(`\r\nAdding user '${user}' ... `)
                setTimeout(() => {
                    var home = `/home/${user}`;
                    var path = navigateToPath("/home", true);
                    if (!path[user]) {
                        shell.write(`done\r\nCopying files from '/etc/skel' ... `)
                        if (navigateToPath("/etc/skel")) {
                            fileSystemFunctions.copy("/etc/skel", home);
                        }
                        shell.write(`done\r\n`)
                    } else {
                        shell.write(`done\r\nThe home directory '${home}' already exists. Not copying files from '/etc/skel'\r\n`)
                    }
                    setTimeout(() => {
                        var userUID = 1000 + users.length;
                        var userJSON = {
                            username: user,
                            password: "",
                            home: home,
                            uid: userUID,
                            groups: [user],
                            stats: {
                                commands: {},
                                files: 0,
                                directories: 0,
                                sudo: 0,
                                uptime: 0,
                                lastLogin: new Date()
                            }
                        }
                        mode = "adduser-passn-" + user;
                        shell.write('New password: ');
                        tries = 0;
                        users.push(userJSON);

                    }, 1000)
                })
                return false;
            }
        },
        {
            name: "userdel",
            root: true,
            description: "Delete a user",
            execute: function (input, currentUser, shell) {
                var user = input.split(' ')[1];
                if (input.includes('--help') || input.includes('-h') || user === undefined || user === "") {
                    output.textContent = `Usage: userdel LOGIN

Options:
  -h, --help                    display this help message and exit
  -r, --remove                  remove home directory`
                    return output;
                }
                if (!users.find(u => u.username === user)) {
                    return `userdel: user '${user}' does not exist\r\n`;
                }
                user = users.find(u => u.username === user);
                if (user.uid === 0) {
                    return `userdel: user '${user.username}' is currently used by process 1\r\n`;
                }
                if (user.UID === currentUser) {
                    return `userdel: user '${user.username}' is currently used by process 1097\r\n`;
                }
                shell.write(`\r\nRemoving user '${user.username}' ... `)
                setTimeout(() => {
                    if (input.includes('--remove') || input.includes('-r')) {
                        shell.write(`done\r\nRemoving home directory '${user.home}' ... `)
                        setTimeout(() => {
                            delete navigateToPath(user.home, true)[getFileName(user.home)];
                            shell.write(`done\r\n`)
                        }, 1000)
                    } else {
                        shell.write(`done\r\n`)
                    }
                    setTimeout(() => {
                        users = users.filter(u => u.username !== user.username);
                        shell.write(`User '${user.username}' removed\r\n`)
                    }, 1500)
                }, 1000)
            }
        },
        {
            name: "sh",
            root: true,
            description: "Run a shell command",
            execute: function (input, currentUser, shell, handleCommand) {
                let file = input.split(' ')[1];
                if (file) {
                    let target = navigateToPath(file) || navigateToPath(`${currentDir}/${file}`);
                    var content = "";
                    if (target === false || target === undefined || target.type === 'directory') {
                        return `sh: ${file}: No such file or directory\r\n`;
                    } else {
                        content = target
                    }
                    var lines = content.split('\n');
                    lines.forEach((line, index) => {
                        handleCommand(line, false)
                    });


                }

            }
        },
        {
            name: "wget",
            description: "Download a file from the internet",
            root: false,
            execute: function (input, currentUser, shell) {
                var url = input.split(' ')[1];
                if (!url) {
                    return 'wget: missing URL operand\r\n';
                }
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = 'http://' + url;
                }
                mode = "waiting";
                fetch(url, {
                    headers: {
                        "User-Agent": "Wget/1.20.3"
                    }
                }).then(response => response.text()).then(body => {
                    var target = input.split(' ')[2];
                    if (!target) {
                        target = url.split('/').pop();
                    }
                    fileSystemFunctions.createFile(userDB, `${currentDir}/${target}`, body);
                    mode = "normal";
                    shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                }).catch(error => {
                    shell.write(`wget: ${error.message}\r\n`);
                    mode = "normal";
                    shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                });
                return false;
            }
        },
        {
            name: "tree",
            description: "Display directory tree",
            root: false,
            execute: function (input, currentUser, shell) {
                var path = input.split(' ')[1] || "/";
                try {
                    let result = fileSystemFunctions.tree(path);
                    console.log(result)
                    result.split('\n').forEach((line, index) => {
                        shell.write(line + '\r\n');
                    });
                    return '';
                } catch (error) {
                    return `tree: ${error.message}\r\n`;
                }
            }
        },
        {
            name: "stats",
            description: "Display user statistics",
            root: false,
            execute: function (input, currentUser, shell) {
                var parsed = parseCommand(input);
                var user = parsed['input'] || users.find(user => user.uid === currentUser).username;
                if (parsed['-help'] || parsed['h']) {
                    let output = `Usage: stats [OPTION] [USER]

Options:
    -c, --commands            display command statistics
    -complete, -all           display all statistics`;

                    var outputFinal = ""
                    output.split("\n").forEach((line, index) => {
                        outputFinal += line + "\r\n";
                    })
                    return outputFinal;
                
                }

                if (!users.find(u => u.username === user)) {
                    return `stats: user '${user}' does not exist\r\n`;
                }

                function randomReadableColor() {
                    var r = Math.floor(Math.random() * 256);
                    var g = Math.floor(Math.random() * 256);
                    var b = Math.floor(Math.random() * 256);
                    if (r + g + b < 60) return randomReadableColor();
                    return { r, g, b };
                }
                let mostUsedCommand,
                    totalCommands

                if (Object.keys(user.stats.commands).length > 0) {
                    mostUsedCommand = Object.keys(user.stats.commands).reduce((a, b) => user.stats.commands[a] > user.stats.commands[b] ? a : b);
                    totalCommands = Object.keys(user.stats.commands).reduce((a, b) => a + b).length;
                } else {
                    mostUsedCommand = "N/A";
                    totalCommands = 0;
                }


                let output = `stats: ${input.split(' ')[1]}: invalid argument\r\n`

                if (parsed['-c'] || parsed['-commands']) {

                    let commandStats = Object.keys( user.stats.commands).sort((a, b) => user.stats.commands[b] - user.stats.commands[a]).map(cmd => {
                        return `${cmd}:${' '.repeat(15 - cmd.length)}${stats.commands[cmd]} times`;
                    }).join('\r\n');

                    output = `Command statistics for ${user}: \r\n`
                    output += `Most used command: ${mostUsedCommand}\r\n`
                    output += `Total commands: ${totalCommands}\r\n`
                    output += `----------------------------------------\r\n`
                    output += `Commands:\r\n`
                    output += commandStats;

                } else if (parsed['-complete'] || parsed['-all']) {
                    output = `Statistics for user '${user}':
Total commands: ${totalCommands}
Most used command: ${mostUsedCommand}
Files created: ${userDB.stats.files}
Directories created: ${userDB.stats.directories}
Sudo commands: ${userDB.stats.sudo}
Time spent: ${formatMilliseconds(userDB.stats.uptime)}
Last login: ${userDB.stats.lastLogin.toLocaleString()}
`;

                } else {
                    output = `Statistics for user '${user}':
                    Total commands: ${totalCommands}
                    Most used command: ${mostUsedCommand}
                    Files created: ${userDB.stats.files}
                    Time spent: ${formatMilliseconds(userDB.stats.uptime)}
                    Last login: ${userDB.stats.lastLogin.toLocaleString()}
                    `;
                }

                var startColor = randomReadableColor();
                var endColor = randomReadableColor();

                var steps = output.split('\n').length;

                //use chalk to colorize the output
                let fade = [];
                for (let i = 0; i < steps; i++) {
                    fade.push(
                        Math.floor(startColor.r + (endColor.r - startColor.r) * i / steps) + ',' +
                        Math.floor(startColor.g + (endColor.g - startColor.g) * i / steps) + ',' +
                        Math.floor(startColor.b + (endColor.b - startColor.b) * i / steps)
                    );
                }

                output.split('\n').forEach((line, index) => {
                    shell.write(`\x1B[38;2;${fade[index]}m${line}\x1B[0m\r\n`);
                })

                return "";

            }
        }
    ]

    client.on('authentication', (ctx) => {
        authCtx = ctx;

        console.log(client._sock.remoteAddress + ' is trying to authenticate with ' + ctx.method + ' method as ' + ctx.username);

        if (!ctx.username) return ctx.reject();
        if (ctx.username === 'rick') return ctx.accept();
        if (ctx.username === "clock") return ctx.accept();
        userDB = users.find(user => user.username === ctx.username);
        if (!userDB) {
            user = { username: ctx.username, password: "", home: "/home/" + ctx.username, uid: 1000 + users.length, groups: [ctx.username], stats: { commands: {}, files: 0, directories: 0, sudo: 0, uptime: 0, lastLogin: new Date() } }
            userDB = user;
            users.push(user);

            if (navigateToPath("/etc/skel")) {
                fileSystemFunctions.copy("/etc/skel", userDB.home);
            }
        }
        lastUser = userDB.uid;
        currentDir = userDB.home;
        if (userDB.password) {
            if (ctx.method === 'password' && userDB.password === ctx.password) {
                ctx.accept();
            } else {
                ctx.reject();
            }
        } else {
            ctx.accept();
        }

    }).on('ready', () => {
        console.log('Client authenticated!');
        console.log('User:', userDB);
        start = new Date()

        client.on('session', (accept, reject) => {
            const session = accept()



            session.on("shell", (accept, reject) => {

                var shell = accept();

                if (authCtx.username === 'clock') {

                    const interval = setInterval(() => {
                        shell.write('\x1Bc');
                        var time = new Date().toLocaleTimeString();
                        var text = figlet.textSync(time, { font: 'Colossal' })
                        text.split("\n").forEach((line, index) => {
                            shell.write(line + "\r\n");
                        });
                    }, 500);

                    shell.on('data', function (data) {
                        if (data == "\u0003") {
                            clearInterval(interval);
                            shell.end();
                        }
                    });


                    return
                } else if (authCtx.username === 'rick') {
                    try {
                        const frames = JSON.parse(fs.readFileSync('frames.txt', 'utf8'));

                        shell.on('data', function (data) {
                            if (data == "\u0003") {
                                shell.end();
                            }
                        });

                        frames.forEach((frame, index) => {
                            setTimeout(() => {
                                shell.write('\x1Bc');

                                if (PTY.cols < 142) {
                                    shell.write('\x1B[31m' + "Please resize your terminal to 142 cols of width (less buggy)" + '\x1B[0m' + "\r\n");
                                }
                                frame.split("\n").forEach((frame, index) => {

                                    shell.write("\x1B ")
                                    var f = frame;
                                    if (PTY.cols < 142) {
                                        f = f.split(";").slice(20).join("");
                                    }
                                    shell.write(f + "\r\n");
                                });
                                if (index === frames.length - 1) {
                                    shell.end();
                                }
                            }, 100 * index);
                        });
                    } catch {
                        shell.write('There was an error! Sorry!');
                        shell.end();
                    }

                    return
                } else if (authCtx.username != "exelv" && authCtx.username != "root" && authCtx.username != "exelvi") {
                    shell.write('\x1B[31m' + 'Hey! I see you are trying to access the terminal! Do you wanted something? \n\r');
                    shell.write('Hacker or not, leave a message (and if you want a reply some contact like email or discord)\x1B[0m\r\n');
                    shell.write('Message (Enter to send): ');

                    let input = '';
                    shell.on('data', function (data) {
                        if (data.toString() === '\r') {
                            shell.write('\r\n');
                            shell.write('Message sent! Thanks!\n\r');
                            console.log('Message from ' + authCtx.username + ': ' + input);
                            let file = fs.readFileSync('messages.txt', 'utf8');
                            fs.writeFileSync('messages.txt', file + '\n' + authCtx.username + '-' + client._sock.remoteAddress + '-' + new Date().toLocaleString() + ': ' + input);
                            shell.end();

                        } else if (data.toString() === '\u007F') {
                            if (input.length > 0) {
                                input = input.slice(0, -1);
                                shell.write('\b \b');
                            } else {
                                //clear line
                                shell.write('\x1B[2K\r');
                                shell.write('Message (Enter to send): ');
                            }
                        } else {
                            input += data.toString();
                            shell.write(data);
                            console.log(data)
                        }

                    });
                    return

                }



                var motd = ""
                if (navigateToPath("/etc/motd")) {
                    motd = fileSystemFunctions.readFileContent("/etc/motd");
                }
                motd.split('').forEach((char, index) => {
                    setTimeout(() => {
                        shell.write(char);
                        if (index === motd.length - 1) {
                            shell.write('\r\n');
                            shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                        }
                    }, 5 * index);
                })



                var input = '';
                var passwordTemp = '';
                shell.on('data', function (data) {

                    console.log('Data:', data.toString());
                    console.log(data);

                    if (data.toString() === '\r') {
                        if (mode === "waiting") return;
                        if (mode.startsWith("supassword-")) {
                            let user = mode.split("-")[1]
                            let dbuser = users.find(u => u.username === user);

                            if (dbuser.password === input) {
                                userDB = dbuser;
                                if (userDB.uid != 0) {
                                    lastUser = userDB.uid;
                                }
                                shell.write('\x1B[2K\r');
                                shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                                mode = "normal";
                                input = '';
                            } else {
                                tries++;
                                if (tries > 2) {
                                    shell.write('su: Authentication failure\r\n');
                                    shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                                    mode = "normal";
                                    input = '';
                                    return;
                                }
                                shell.write('\x1B[2K\r');
                                shell.write('Wrong password\r\nPassword: ');
                                input = '';
                                return;

                            }
                        } else if (mode.startsWith("passwd-")) {
                            const passwdMode = mode.split("-")[1]
                            const user = mode.split("-")[2]

                            if (passwdMode == "c") {
                                if (users.find(u => u.username === user).password === input) {
                                    mode = "passwd-n-" + user;
                                    shell.write('\x1B[2K\r');
                                    shell.write('New password: ');
                                    input = '';
                                    return;
                                } else {
                                    tries++;
                                    if (tries > 2) {
                                        shell.write('passwd: Authentication failure\r\n');
                                        shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                                        mode = "normal";
                                        input = '';
                                        return;
                                    }
                                    shell.write('\x1B[2K\r');
                                    shell.write('Wrong password\r\nCurrent password: ');
                                    input = '';
                                    return;
                                }
                            } else if (passwdMode == "n") {
                                mode = "passwd-cc-" + user;
                                input = '';
                                passwordTemp = input;
                                shell.write('\x1B[2K\r');
                                shell.write('Confirm password: ');
                            } else if (passwdMode == "cc") {
                                if (input === passwordTemp) {
                                    users.find(u => u.username === user).password = input;
                                    shell.write('\r\n');
                                    shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                                    mode = "normal";
                                    input = '';
                                } else {
                                    shell.write('\r\npasswd: Authentication token manipulation error\r\npasswd: password unchanged\r\n');
                                    shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                                    mode = "normal";
                                    input = '';
                                    return;
                                }
                            }
                        } else if (mode.startsWith("sudo-")) {
                            let user = userDB.uid
                            let inputC = mode.split("sudo-")[1]
                            if (users.find(u => u.uid === user)?.password === input) {
                                sudoLogin = true;
                                mode = "normal";
                                tries = 0;
                                shell.write('\x1B[2K\r');
                                handleCommand("sudo " + inputC, false);
                            } else {
                                tries++;
                                if (tries > 2) {
                                    shell.write('sudo: Authentication failure\r\n');
                                    shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                                    mode = "normal";
                                    input = '';
                                    tries = 0;
                                    return;
                                }
                                shell.write('\x1B[2K\r');
                                shell.write('Wrong password\r\nPassword: ');
                                input = '';
                                return;
                            }

                        } else if (mode.startsWith("adduser-")) {
                            let mod = mode.split("-")[1];
                            let user = mode.split("-")[2];

                            if (mod == "passn") {
                                mode = "adduser-passc-" + user;
                                input = '';
                                passwordTemp = input;
                                shell.write('\x1B[2K\r');
                                shell.write('Confirm password: ');

                            } else if (mod == "passc") {
                                if (input === passwordTemp) {
                                    users.find(u => u.username === user).password = input;
                                    shell.write('\r\n');
                                    shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                                    mode = "normal";
                                    input = '';
                                } else {
                                    shell.write('\r\nSorry, passwords do not match\r\n');
                                    shell.write('passwd: Authentication token manipulation error\r\npasswd: password unchanged\r\n');
                                    shell.write(`Try again [y/n]: `);
                                    mode = "confirm-adduser-passn-" + user;
                                    input = '';
                                    return;

                                }
                            }
                        } else if (mode.startsWith("confirm-")) {
                            let functionString = mode.split("confirm-")[1];

                            if (input == "y") {
                                shell.write('\r\n');
                                shell.write(`New password: `);
                                input = '';
                                mode = functionString;
                            } else {
                                shell.write('\r\n');
                                shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                                mode = "normal";
                                input = '';
                            }
                        } else {
                            handleCommand(input);
                            input = '';
                        }


                    } else if (data.toString() === '\u0003') {
                        shell.write('^C');
                        shell.write(`\r\n${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);

                        mode = "normal";
                        input = '';
                    } else if (data.toString() === '\u007F') {
                        if (input.length > 0) {
                            input = input.slice(0, -1);
                            if (!mode.startsWith("passwd") && !mode.startsWith("supassword") && !mode.startsWith("sudo")) shell.write('\b \b');
                        }
                    } else if (data.toString() === '\u0009') {
                        if (mode == "normal") {
                            if (first) {
                                tabMachPosition = 0;
                                tabMachCommandPosition = 0;
                                first = false;

                                hinput = input
                                command = hinput.split(' ')[0];
                                commandList = commands.map(function (command) {
                                    return command.name;
                                });
                                matchingCommands = commandList.filter(function (commandName) {
                                    return commandName.startsWith(command);
                                });
                            }

                            fileListing = navigateToPath(currentDir);
                            fileNames = Object.keys(fileListing);
                            matchingFiles = fileNames.filter(function (fileName) {
                                return fileName.startsWith(hinput.split(' ')[1] || '');
                            });

                            if (matchingCommands.length === 1) {
                                if (matchingCommands[0] == command) {
                                    const file = matchingFiles[tabMachPosition];
                                    if (file) {
                                        input = command + ' ' + file;
                                        shell.write('\x1B[2K\r');
                                        shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} ${input}`);
                                        tabMachPosition++;
                                        if (tabMachPosition >= matchingFiles.length) {
                                            tabMachPosition = 0;
                                        }
                                    }
                                } else {
                                    input = matchingCommands[0];
                                    shell.write('\x1B[2K\r');
                                    shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} ${input}`);
                                }
                            } else if (matchingCommands.length > 1) {
                                input = matchingCommands[tabMachCommandPosition];
                                shell.write('\x1B[2K\r');
                                shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} ${input}`);
                                tabMachCommandPosition++;
                                if (tabMachCommandPosition >= matchingCommands.length) {
                                    tabMachCommandPosition = 0;
                                }
                            }

                        }
                    } else if (data.toString() === '\u001b[A') {
                        let bashHistory = fileSystemFunctions.getBashHistory(userDB).split('\n');
                        if (hystoryPosition < bashHistory.length) {
                            hystoryPosition++;
                            input = bashHistory[bashHistory.length - hystoryPosition];
                            shell.write('\x1B[2K\r');
                            shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} ${input}`);
                        }
                    } else if (data.toString() === '\u001b[B') {
                        let bashHistory = fileSystemFunctions.getBashHistory(userDB).split('\n');
                        if (hystoryPosition > 1) {
                            hystoryPosition--;
                            input = bashHistory[bashHistory.length - hystoryPosition];
                            shell.write('\x1B[2K\r');
                            shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} ${input}`);
                        }
                    } else {
                        input += data;
                        if (!mode.startsWith("passwd") && !mode.startsWith("supassword") && !mode.startsWith("sudo")) shell.write(data);
                        tabMachPosition = 0;
                        tabMachCommandPosition = 0;
                        first = true;
                    }
                });


                function handleCommand(input, out = true) {
                    let output = '';
                    hystoryPosition = 1;
                    try {
                        fileSystemFunctions.addToBashHistory(userDB, input);
                    } catch (error) {
                        console.log(error)
                    }
                    output += `${userDB.uid == 0 ? '\r\n\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} ${input}\r\n`;

                    if (out) {
                        shell.write(output);
                        output = '';
                    }

                    var currentUser = userDB.uid

                    if (input.startsWith('sudo')) {
                        if (currentUser === 0 || sudoLogin || users.find(user => user.username === 'root').password === "") {
                            input = input.substring(5);
                            currentUser = 0;
                            userDB.stats.sudo++;
                        } else {
                            input = input.substring(5);
                            tries = 0;
                            shell.write('Password: ');
                            mode = "sudo-" + input;
                            return
                        }
                    }

                    var command = commands.find(function (command) {
                        return input.split(' ')[0] === command.name;
                    });

                    if (!command) {
                        var alias = fileSystemFunctions.readFileContent(`${userDB.home}/.bash_aliases`);

                        if (alias) {
                            alias = alias.split('\n');
                            alias.forEach(function (line) {
                                if (line.split('=')[0] === input.split(' ')[0]) {
                                    input = line.split('=')[1].slice(1, -1) + ' ' + input.split(' ').slice(1).join(' ');
                                    command = commands.find(function (command) {
                                        return input.split(' ')[0] === command.name;
                                    });
                                }
                            });
                        }

                        command = commands.find(function (command) {
                            return input.split(' ')[0] === command.name;
                        });
                    }

                    if (command) {
                        userDB.stats.commands[command.name] = userDB.stats.commands[command.name] ? userDB.stats.commands[command.name] + 1 : 1;
                        var out = command.execute(input, currentUser, shell, handleCommand);

                        if (out === false) return;

                        var inputParts = input.split(' ');
                        if (inputParts[inputParts.length - 2] === '>') {
                            if (inputParts[inputParts.length - 1] === "") {
                                if (out != "" && out != undefined) shell.write(out);
                            } else {
                                var fileName = inputParts[inputParts.length - 1];
                                if (fileName.startsWith('/')) {
                                    fileSystemFunctions.createFile(userDB, fileName, out);
                                } else {
                                    fileSystemFunctions.createFile(userDB, `${currentDir}/${fileName}`, out);
                                }
                            }

                        } else {
                            if (out != "" && out != undefined) shell.write(out);
                        }
                    } else {
                        if (input !== "") {
                            shell.write(`${input.split(' ')[0]}: command not found \r\n`);
                        }
                    }


                    shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                }

            });

            session.on("pty", (accept, reject, info) => {
                console.log("PTY", info);
                PTY = info;
                accept();
            });


        })
    }).on('close', () => {
        console.log('Client disconnected');
        userDB.stats.uptime += new Date() - start;
    }).on('error', (err) => {
        console.error('Client error:', err);
    });
})

server.listen(22, () => {
    fileSystem = db.get().fileSystem;
    users = db.get().users;
    console.log('Listening on port ' + server.address().port);
});

server.on('error', (err) => {
    console.error('Server error:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(reason, 'at', promise);
})

process.on('SIGINT', () => {
    console.log('Stopping server...');
    server.close(() => {
        console.log('Server stopped');
    });
    console.log('Saving database...');
    db.set({ users: users, fileSystem: fileSystem });
    console.log('Database saved');
    process.exit(0);
});