const { timingSafeEqual } = require('crypto');
const fs = require('fs');
const { inspect } = require('util');
const { utils: { generateKeyPairSync } } = require('ssh2');
const { utils: { parseKey }, Server } = require('ssh2');
const ssh2 = require('ssh2')

ssh2.createAgent("pageant")

var instanceName = "sandbox"

var hystoryPosition = 0;

let fileSystem = {}
let users = []

const fileSystemFunctions = {
    createFile: function (userDB, path, content = '',) {
        const parentDir = navigateToPath(path, true);
        parentDir[getFileName(path)] = { content: content, owner: userDB.uid, size: content.length, lastModified: new Date(), created: new Date(), type: 'file' };
        userDB.stats.files++;
    },
    createDirectory: function (userDB, path) {
        const parentDir = navigateToPath(path, true);
        parentDir[getFileName(path)] = { owner: userDB.uid, lastModified: new Date(), created: new Date(), type: 'directory', content: {} };
        userDB.stats.directories++;
    },
    changeFileContent: function (path, content) {
        const file = navigateToPath(path);
        if (file.type == 'file') {
            const parentDir = navigateToPath(path, true);
            parentDir[getFileName(path)].content = content;
            parentDir[getFileName(path)].size = content.length;
            parentDir[getFileName(path)].lastModified = new Date();
        } else {
            return false
        }
    },
    remove: function (path) {
        const parentDir = navigateToPath(path, true);
        delete parentDir[getFileName(path)];
    },
    getBashHistory: function (userDB) {
        var userDir = navigateToPath(userDB.home);
        if (userDir[".bash_history"] === undefined) {
            this.createFile(userDB, `${userDB.home}/.bash_history`);
            userDir = navigateToPath(userDB.home);
        }
        return navigateToPath(`${userDB.home}/.bash_history`, true)["content"];
    },
    addToBashHistory: function (userDB, command) {
        var userDir = navigateToPath(userDB.home);
        if (userDir[".bash_history"] === undefined) {
            this.createFile(userDB, `${userDB.home}/.bash_history`);
            userDir = navigateToPath(userDB.home);
        }
        console.log(userDir)
        navigateToPath(`${userDB.home}/.bash_history`, true)["content"] += command + "\n";
    },
    tree: function (path, indent = '') {
        let treeOutput = '';
        const target = navigateToPath(path);

        if (target.type !== 'directory') {
            throw new Error('Path not found');
        }

        const keys = Object.keys(target);
        keys.forEach((key, index) => {
            const isLast = index === keys.length - 1;
            treeOutput += indent + (isLast ? '└── ' : '├── ') + key + '\n';
            if (target[key].type === 'directory') {
                treeOutput += this.tree(`${path}/${key}`, indent + (isLast ? '    ' : '│   '));
            }
        });

        return treeOutput;
    },
    readFileContent: function (path) {
        const file = navigateToPath(path);
        if (file && file.type === 'file') {
            return file.content;
        } else {
            return false;
        }
    },
    copy: function (source, destination) {
        const sourceObj = navigateToPath(source);
        if (sourceObj === false) {
            throw new Error('Source path not found');
        }
        const destinationDir = navigateToPath(destination, true);
        if (destinationDir === false) {
            throw new Error('Destination path not found');
        }
        console.log(destinationDir)
        destinationDir[getFileName(destination)] = { ...sourceObj };
        console.log(destinationDir)
    },
    move: function (source, destination) {
        this.copy(source, destination);
        this.remove(source);
    },
};


function navigateToPath(path, parent = false) {
    const parts = path.split('/').filter(part => part.length > 0);
    let current = fileSystem['/'];
   for (let i = 0; i < (parent ? parts.length - 1 : parts.length); i++) {
        const part = parts[i];
        if (current[part] === undefined) {
            return false;
        }
        current = current[part].content;
    }

    return current;
}

function getFileName(path) {
    const parts = path.split('/');
    return parts[parts.length - 1];
}


const db = require('./db');
const { create } = require('domain');

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
                    fileSystemFunctions.createFile(`${currentDir}/${fileName}`, fileName == "grass.txt" ? "Time to go outside :)" : "");
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
                    fileSystemFunctions.remove(`${currentDir}/${path}`);
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
                try {
                    return fileSystemFunctions.readFileContent(`${currentDir}/${fileName}`) + '\r\n';
                } catch (error) {
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
                const params = input.split(' ')
                const currentDirContent = navigateToPath(currentDir);
                if (params[2]) {
                    const target = navigateToPath(`${currentDir}/${params[2]}`);
                    if (target) currentDirContent = target;
                } else if (params[1]) {
                    const target = navigateToPath(`${currentDir}/${params[1]}`);
                    if (target) currentDirContent = target;
                }

                if (params[1] == "-la") {
                    var output = 'total ' + Object.keys(currentDirContent).length + '\r\n';
                    Object.keys(currentDirContent).forEach((key) => {
                        output += `${currentDirContent[key].type == 'directory' ? 'd' : '-'}rwxr-xr-x 1 ${currentDirContent[key].owner} ${currentDirContent[key].owner} ${currentDirContent[key].size} ${currentDirContent[key].lastModified} ${key}\r\n`;
                    });
                    return output;
                } else {
                }
                
            },
        },
        {
            name: "eval",
            description: "Evaluate JavaScript code",
            root: false,
            execute: function (input) {
                var code = input.split(' ').slice(1).join(' ');
                try {
                    return inspect(eval(code)) + '\r\n';
                }
                catch (error) {
                    return error.message + '\r\n';
                }
            }
        }


    ]

    client.on('authentication', (ctx) => {
        authCtx = ctx;
        if (!ctx.username) return ctx.reject();
        userDB = users.find(user => user.username === ctx.username);
        if (!userDB) {
            user = { username: ctx.username, password: "", home: "/home/" + ctx.username, uid: 1000 + users.length, groups: [ctx.username], stats: { commands: {}, files: 0, directories: 0, sudo: 0, uptime: 0, lastLogin: new Date() } }
            userDB = user;
            users.push(user);
            console.log(navigateToPath("/etc/skel"))
            if (navigateToPath("/etc/skel")) {
                fileSystemFunctions.copy("/etc/skel", userDB.home);
            }
        }
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

        client.on('session', (accept, reject) => {
            const session = accept()



            session.on("shell", (accept, reject) => {

                var shell = accept();

                if (authCtx.username === 'rick') {
                    try {
                        const frames = JSON.parse(fs.readFileSync('frames.txt', 'utf8'));

                        frames.forEach((frame, index) => {
                            setTimeout(() => {
                                shell.write('\x1Bc');
                                frame.split("\n").forEach((frame, index) => {
                                    shell.write(frame + "\r\n");
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
                        }
                    }, 5 * index);
                })



                var input = '';
                shell.on('data', function (data) {

                    console.log('Data:', data.toString());
                    shell.write(data);

                    console.log(data);

                    if (data.toString() === '\r') {
                        handleCommand(input);
                        input = '';
                    } else if (data.toString() === '\u0003') {
                        shell.write('^C');
                        input = '';
                    } else if (data.toString() === '\u007F') {
                        if (input.length > 0) {
                            input = input.slice(0, -1);
                            shell.write('\b \b');
                        }
                    } else input += data;
                });


                function handleCommand(input, out = true) {
                    var output = '';

                    try {
                        fileSystemFunctions.addToBashHistory(userDB, input);
                    } catch (error) {
                        console.log(error)
                    }
                    output += `${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} ${input}\r\n`;

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
                        var out = command.execute(input, currentUser);
                        if (!out) return;

                        var inputParts = input.split(' ');
                        if (inputParts[inputParts.length - 2] === '>') {
                            if (inputParts[inputParts.length - 1] === "") {
                                shell.write(out);
                            } else {
                                var fileName = inputParts[inputParts.length - 1];
                                if (fileName in navigateToPath(currentDir)) {
                                    fileSystemFunctions.changeFileContent(`${currentDir}/${fileName}`, out.textContent);
                                } else {
                                    fileSystemFunctions.createFile(userDB, `${currentDir}/${fileName}`, out.textContent);
                                }
                            }

                        } else {
                            shell.write(out);
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
    }).on('error', (err) => {
        console.error('Client error:', err);
    });
})

server.listen(22, '127.0.0.1', () => {
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