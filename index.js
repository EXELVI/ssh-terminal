const { timingSafeEqual } = require('crypto');
const fs = require('fs');
const { inspect } = require('util');
const { utils: { generateKeyPairSync } } = require('ssh2');
const { utils: { parseKey }, Server } = require('ssh2');
const ssh2 = require('ssh2')

ssh2.createAgent("pageant")


var hystoryPosition = 0;

let fileSystem = {}

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
    var userDB = {}
    client.on('authentication', (ctx) => {
        authCtx = ctx;
        if (!ctx.username) return ctx.reject();
        userDB = db.get().users.find(user => user.username === ctx.username);
        if (!userDB) {
            user = { username: ctx.username, password: "", shell: "/bin/bash", home: "/home/" + ctx.username, uid: 1000 + db.get().users.length, groups: [ctx.username] }
            db.get().users.push(user)
            userDB = user
        }
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

        client.on('session', (accept, reject) => {
            const session = accept()



            session.on("shell", (accept, reject) => {

                var shell = accept();

                if (authCtx.username === 'rick') { // Easter egg :D
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

                const motd = `Welcome to the terminal!\r\n`;

                motd.split('').forEach((char, index) => {
                    setTimeout(() => {
                        shell.write(char);
                    }, 50 * index);
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

                    switch (command) {
                        case 'echo':
                            shell.write(args.join(' '));
                            break;
                        case 'exit':
                            shell.write('Goodbye!\r\n');
                            shell.end();
                            break;
                        case 'clear':
                            shell.write('\x1Bc');
                            break;
                        case 'color':
                            shell.write('\x1B[31m');
                            break;
                        default:
                            shell.write(`Unknown command: ${command}\r\n`);
                    }
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

    fileSystem = db.get().fileSystem

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
    db.set({ users: db.get().users, fileSystem: fileSystem });
    console.log('Database saved');
    process.exit(0);
});