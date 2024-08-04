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
    createFile: function (userDB, path, content = '', ) {
        const parentDir = navigateToPath(path, true);
        parentDir[getFileName(path)] = content;
        
    },
    getBashHistory: function (userDB) {
        var userDir = navigateToPath(userDB.home);
        if (userDir[".bash_history"] === undefined) {
            this.createFile(userDB, `${userDB.home}/.bash_history`);
            userDir = navigateToPath(userDB.home);
        }
        return userDir[".bash_history"];
    },
    addToBashHistory: function (userDB, command) {
        var userDir = navigateToPath(userDB.home);
        if (userDir[".bash_history"] === undefined) {
            this.createFile(userDB, `${userDB.home}/.bash_history`);
            userDir = navigateToPath(userDB.home);
        }
        userDir[".bash_history"] += command + "\n";
    },
    tree: function (path, indent = '') {
        let treeOutput = '';
        const target = navigateToPath(path);

        if (typeof target !== 'object') {
            throw new Error('Path not found');
        }

        const keys = Object.keys(target);
        keys.forEach((key, index) => {
            const isLast = index === keys.length - 1;
            treeOutput += indent + (isLast ? '└── ' : '├── ') + key + '\n';
            if (typeof target[key] === 'object') {
                treeOutput += this.tree(`${path}/${key}`, indent + (isLast ? '    ' : '│   '));
            }
        });

        return treeOutput;
    }
};


function navigateToPath(path, parent = false) {
    const parts = path.split('/').filter(part => part.length > 0);
    let current = fileSystem['/'];
    for (let i = 0; i < (parent ? parts.length - 1 : parts.length); i++) {
        current = current[parts[i]];
        if (current === undefined) {
            return false
        }
    }
    return current;
}

function getFileName(path) {
    const parts = path.split('/');
    return parts[parts.length - 1];
}


const db = require('./db');

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
    client.on('authentication', (ctx) => {
        authCtx = ctx;
        if (!ctx.username) return ctx.reject();
        userDB = users.find(user => user.username === ctx.username);
        if (!userDB) {
            user = { username: ctx.username, password: "", home: "/home/" + ctx.username, uid: 1000 + users.length, groups: [ctx.username], stats: { commands: {}, files: 0, directories: 0, sudo: 0, uptime: 0, lastLogin: new Date() } }
            userDB = user
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
                console.log(fileSystem)
                if (fileSystem["/"].etc?.motd) {
                    motd = fileSystem["/"].etc.motd
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
                        shell.write('\b \b');
                        input = input.slice(0, -1);
                    } else input += data;
                });


                function handleCommand(input) {
                    const [command, ...args] = input.split(' ');
                    var output = '';

                    try {
                        fileSystemFunctions.addToBashHistory(userDB, input);
                    } catch (error) {
                        console.log(error)
                    }
                    output += `${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `;

              

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