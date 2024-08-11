const fs = require('fs');
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
/**
 * 
 * @param {ssh2.ShellOptions} options
 * @param {Boolean} isCommand 
 * @param {object} options 
 * @param {string} options.input
 * @param {string} options.selector
 */
function startRockPaperScissorsGame(stream, isCommand = false, options = {}) {
    const choices = ['rock', 'paper', 'scissors'];

    let playerChoice = null;
    let selector = 0;
    let aiChoice = null;
    let awaitingConfirm = false;

    if (isCommand) {
        if (options.selector) {
            selector = parseInt(options.selector);
        }
    }

    function colorChoice(choice) {
        switch (choice) {
            case 'rock': return chalk.red(choice);
            case 'paper': return chalk.blue(choice);
            case 'scissors': return chalk.green(choice);
        }
    }


    function printBoard() {
        if (!isCommand)stream.write('\x1Bc');
        else {
            stream.write('\x1B[2J\x1B[0;0f');

        }
        stream.write('Rock Paper Scissors\r\n');
        stream.write('Use a/d or arrow keys to select, space to confirm\r\n');
        stream.write('\r\n');
        stream.write(choices.map((choice, index) => index === selector ? `> ${colorChoice(choice)}` : `  ${colorChoice(choice)}`).join('\r\n') + '\r\n');
    }


    function aiMove() {
        aiChoice = choices[Math.floor(Math.random() * choices.length)];
    }

    let inp = "";

    if (!isCommand) {
        stream.on('data', (data) => {
            const input = data.toString();
            if (awaitingConfirm) {
                if (input == "\x03") {
                    stream.end();
                } else if (input === '\r') {
                    if (inp === 'y') {
                        playerChoice = null;
                        aiChoice = null;
                        awaitingConfirm = false;
                        stream.write('\x1Bc');
                        printBoard();
                    } else if (inp === 'n') {
                        stream.write('\r\n');
                        stream.end();
                    } else {
                        stream.write('\x1Bc');
                        stream.write('Do you want to play again? (y/n) ');
                        inp = "";
                    }
                } if (input == "\u007F") {
                    if (inp.length > 0) {
                        inp = inp.slice(0, -1);
                        stream.write('\b \b');
                    }

                } else {
                    let allowToWrite = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890!@#$%^&*()_+-=[]{}|;':,.<>/?".split("");
                    if (allowToWrite.includes(input)) {
                        inp += input;
                        stream.write(input);
                    }
                }


            } else {
                if (input === '\x03') {
                    stream.end();
                } else if (input === 'a' || input === '\x1B[D' || input === 'w' || input === '\x1B[A') {
                    selector = Math.max(selector - 1, 0);
                    printBoard();
                } else if (input === 'd' || input === '\x1B[C' || input === 's' || input === '\x1B[B') {
                    selector = Math.min(selector + 1, choices.length - 1);
                    printBoard();
                }
                else if (input === ' ' || input === '\r') {
                    if (playerChoice === null) {
                        playerChoice = choices[selector];
                        aiMove();
                        awaitingConfirm = true;
                        stream.write('\x1Bc');
                        stream.write(`You chose: ${colorChoice(playerChoice)}\r\n`);
                        stream.write(`AI chose: ${colorChoice(aiChoice)}\r\n`);
                        let result = '';
                        if (playerChoice === aiChoice) {
                            result = chalk.yellow('It\'s a tie!');
                        } else if (playerChoice === 'rock' && aiChoice === 'scissors' ||
                            playerChoice === 'paper' && aiChoice === 'rock' ||
                            playerChoice === 'scissors' && aiChoice === 'paper') {
                            result = chalk.green('You win!');
                        } else {
                            result = chalk.red('AI wins!');
                        }
                        stream.write(result + '\r\n');
                        stream.write('Do you want to play again? (y/n) ');
                        inp = "";

                    }
                }
            }
        });
    } else {
        if (options.input) {
            let input = options.input.toString();
            if (input === '\x03') {
                return false;
            } else if (input === 'a' || input === '\x1B[D' || input === 'w' || input === '\x1B[A') {
                selector = Math.max(selector - 1, 0);
                printBoard();
                return {
                    selector: selector
                }
            } else if (input === 'd' || input === '\x1B[C' || input === 's' || input === '\x1B[B') {
                selector = Math.min(selector + 1, choices.length - 1);
                printBoard();
                return {
                    selector: selector
                }
            }
            else if (input === ' ' || input === '\r') {
                if (playerChoice === null) {
                    playerChoice = choices[selector];
                    aiMove();
                    stream.write('\r\n');
                    stream.write(`You chose: ${colorChoice(playerChoice)}\r\n`);
                    stream.write(`AI chose: ${colorChoice(aiChoice)}\r\n`);
                    let result = '';
                    if (playerChoice === aiChoice) {
                        result = chalk.yellow('It\'s a tie!');
                    } else if (playerChoice === 'rock' && aiChoice === 'scissors' ||
                        playerChoice === 'paper' && aiChoice === 'rock' ||
                        playerChoice === 'scissors' && aiChoice === 'paper') {
                        result = chalk.green('You win!');
                    } else {
                        result = chalk.red('AI wins!');
                    }
                    stream.write(result + '\r\n');
                    return false;

                }
            }
        }
    }


    printBoard();

}

function startTicTacToeGame(stream) {
    let board = [
        [' ', ' ', ' '],
        [' ', ' ', ' '],
        [' ', ' ', ' ']
    ];

    let xAscii = [
        "Y88b   d88P ",
        " Y88b d88P  ",
        "  Y88o88P   ",
        "   Y888P    ",
        "   d888b    ",
        "  d88888b   ",
        " d88P Y88b  ",
        "d88P   Y88b "
    ];

    let oAscii = [
        " .d88888b.  ",
        "d88P\" \"Y88b ",
        "888     888 ",
        "888     888 ",
        "888     888 ",
        "888     888 ",
        "Y88b. .d88P ",
        " \"Y88888P\"  "
    ];

    let questionAscii = [
        "    8888    ",
        "    8888    ",
        "    8888    ",
        "    8888    ",
        "    8888    ",
        "    Y88P    ",
        "     \"\"     ",
        "    8888    "
    ]


    let currentPlayer = 'X';
    let selectorRow = 0;
    let selectorCol = 0;

    function aiMove() {
        let bestScore = -Infinity;
        let move;
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                if (board[i][j] === ' ') {
                    board[i][j] = 'O';
                    let score = minimax(board, 0, false);
                    board[i][j] = ' ';
                    if (score > bestScore) {
                        bestScore = score;
                        move = { i, j };
                    }
                }
            }
        }
        board[move.i][move.j] = 'O';
    }

    function minimax(board, depth, isMaximizing) {
        if (checkWin('X')) return -10;
        if (checkWin('O')) return 10;
        if (checkTie()) return 0;

        if (isMaximizing) {
            let bestScore = -Infinity;
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    if (board[i][j] === ' ') {
                        board[i][j] = 'O';
                        let score = minimax(board, depth + 1, false);
                        board[i][j] = ' ';
                        bestScore = Math.max(score, bestScore);
                    }
                }
            }
            return bestScore;
        } else {
            let bestScore = Infinity;
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    if (board[i][j] === ' ') {
                        board[i][j] = 'X';
                        let score = minimax(board, depth + 1, true);
                        board[i][j] = ' ';
                        bestScore = Math.min(score, bestScore);
                    }
                }
            }
            return bestScore;
        }
    }


    function printBoard(invalidMove = false) {
        stream.write('\x1Bc');

        for (let i = 0; i < 3; i++) {
            for (let row = 0; row < 8; row++) {
                for (let j = 0; j < 3; j++) {
                    let cell = board[i][j];
                    if (cell === 'X') {
                        let text = chalk.red(xAscii[row])
                        if (j === selectorCol && i === selectorRow) {
                            if (invalidMove) {
                                text = chalk.red(questionAscii[row]);
                            }
                            text = chalk.bgRgb(20, 20, 20)(text);

                        }
                        stream.write(text);
                    } else if (cell === 'O') {
                        let text = chalk.blue(oAscii[row]);
                        if (j === selectorCol && i === selectorRow) {
                            if (invalidMove) {
                                text = chalk.blue(questionAscii[row]);
                            }
                            text = chalk.bgRgb(20, 20, 20)(text);
                        }
                        stream.write(text);
                    } else {
                        if (j === selectorCol && i === selectorRow) {
                            stream.write(chalk.bgRgb(20, 20, 20)(' '.repeat(12)));
                        } else {
                            stream.write(' '.repeat(12));
                        }
                    }
                    if (j < 2) {
                        stream.write(' | ');
                    }
                }
                stream.write('\r\n');

            }
            if (i < 2) {
                stream.write('-------------+--------------+-------------\r\n');
            }

        }
        stream.write('\r\n');
    }

    function checkWin(player) {
        for (let i = 0; i < 3; i++) {
            if (board[i][0] === player && board[i][1] === player && board[i][2] === player) return true;
            if (board[0][i] === player && board[1][i] === player && board[2][i] === player) return true;
        }
        if (board[0][0] === player && board[1][1] === player && board[2][2] === player) return true;
        if (board[0][2] === player && board[1][1] === player && board[2][0] === player) return true;
        return false;
    }

    function checkTie() {
        return board.flat().every(cell => cell !== ' ');
    }

    stream.on('data', (data) => {
        const input = data.toString();
        if (input === '\x03') {
            stream.end();
        } else if (input === 'w' || input === '\x1B[A') {
            selectorRow = Math.max(selectorRow - 1, 0);
        } else if (input === 'a' || input === '\x1B[D') {
            selectorCol = Math.max(selectorCol - 1, 0);
        } else if (input === 's' || input === '\x1B[B') {
            selectorRow = Math.min(selectorRow + 1, 2);
        } else if (input === 'd' || input === '\x1B[C') {
            selectorCol = Math.min(selectorCol + 1, 2);

        } else if (input === ' ' || input === '\r') {
            if (board[selectorRow][selectorCol] === ' ') {
                board[selectorRow][selectorCol] = currentPlayer;
                if (checkWin(currentPlayer)) {
                    printBoard();
                    stream.write(chalk.green(`${currentPlayer} wins!\r\n`));
                    stream.end();
                } else if (checkTie()) {
                    printBoard();
                    stream.write(chalk.yellow('It\'s a tie!\r\n'));
                    stream.end();
                } else {
                    currentPlayer = currentPlayer === 'X' ? 'O' : 'X';
                }
                aiMove();
                if (checkWin('O')) {
                    printBoard();
                    stream.write(chalk.blue('AI wins!\r\n'));
                    stream.end();
                } else if (checkTie()) {
                    printBoard();
                    stream.write(chalk.yellow('It\'s a tie!\r\n'));
                    stream.end();
                } else {
                    currentPlayer = 'X';
                }

                printBoard();
            } else {
                printBoard(true);
                setTimeout(() => printBoard(), 200);
            }
        }
        if (input !== ' ' && input !== '\r') {
            printBoard();
        }
    });

    printBoard();
}



function start2048Game(stream) {
    const gridSize = 4;
    let grid = createGrid(gridSize);
    let score = 0;

    function createGrid(size) {
        let grid = [];
        for (let i = 0; i < size; i++) {
            grid.push(new Array(size).fill(0));
        }
        return grid;
    }

    function addRandomTile() {
        let emptyTiles = [];
        for (let r = 0; r < gridSize; r++) {
            for (let c = 0; c < gridSize; c++) {
                if (grid[r][c] === 0) {
                    emptyTiles.push([r, c]);
                }
            }
        }

        if (emptyTiles.length > 0) {
            let [row, col] = emptyTiles[Math.floor(Math.random() * emptyTiles.length)];
            grid[row][col] = Math.random() < 0.9 ? 2 : 4;
        }
    }

    function colorTile(val, txt = true) {
        let text = val === 0 ? '   ' : val.toString().padStart(3);
        if (!txt) text = '   ';
        switch (val) {
            case 2: return chalk.bgHex("eee4da").black(` ${text} `);
            case 4: return chalk.bgHex("ede0c8").black(` ${text} `);
            case 8: return chalk.bgHex("f2b179").black(` ${text} `);
            case 16: return chalk.bgHex("f59563").black(` ${text} `);
            case 32: return chalk.bgHex("f67c5f").black(` ${text} `);
            case 64: return chalk.bgHex("f65e3b").black(` ${text} `);
            case 128: return chalk.bgHex("edcf72").black(` ${text} `);
            case 256: return chalk.bgHex("edcc61").black(` ${text} `);
            case 512: return chalk.bgHex("edc850").black(` ${text} `);
            case 1024: return chalk.bgHex("edc53f").black(` ${text} `);
            case 2048: return chalk.bgHex("edc22e").black(` ${text} `);
            default: return chalk.bgHex("cdc1b5").black(` ${text} `);
        }
    }

    function printGrid() {
        stream.write('\x1Bc');
        stream.write(`Score: ${score}` + '\r\n');

        for (let r = 0; r < gridSize; r++) {
            stream.write(grid[r].map(val => colorTile(val, false)).join('') + '\r\n');
            stream.write(grid[r].map(val => colorTile(val)).join('') + '\r\n');
            stream.write(grid[r].map(val => colorTile(val, false)).join('') + '\r\n');
        }
    }

    function combineRowLeft(row) {
        let newRow = row.filter(val => val !== 0);
        for (let i = 0; i < newRow.length - 1; i++) {
            if (newRow[i] === newRow[i + 1]) {
                newRow[i] *= 2;
                score += newRow[i];
                newRow[i + 1] = 0;
            }
        }
        return newRow.filter(val => val !== 0).concat(new Array(gridSize).fill(0)).slice(0, gridSize);
    }

    function moveLeft() {
        let changed = false;
        for (let r = 0; r < gridSize; r++) {
            let newRow = combineRowLeft(grid[r]);
            if (grid[r].toString() !== newRow.toString()) {
                changed = true;
            }
            grid[r] = newRow;
        }
        if (changed) addRandomTile();
    }




    function rotateGrid() {
        let newGrid = createGrid(gridSize);
        for (let r = 0; r < gridSize; r++) {
            for (let c = 0; c < gridSize; c++) {
                newGrid[c][gridSize - 1 - r] = grid[r][c];
            }
        }
        grid = newGrid;
    }

    function moveRight() {
        rotateGrid();
        rotateGrid();
        moveLeft();
        rotateGrid();
        rotateGrid();
    }

    function moveUp() {
        rotateGrid();
        rotateGrid();
        rotateGrid();
        moveLeft();
        rotateGrid();
    }

    function moveDown() {
        rotateGrid();
        moveLeft();
        rotateGrid();
        rotateGrid();
        rotateGrid();
    }

    function isGameOver() {
        for (let r = 0; r < gridSize; r++) {
            for (let c = 0; c < gridSize; c++) {
                if (grid[r][c] === 0) return false;
                if (c < gridSize - 1 && grid[r][c] === grid[r][c + 1]) return false;
                if (r < gridSize - 1 && grid[r][c] === grid[r + 1][c]) return false;
            }
        }
        return true;
    }

    stream.on('data', (data) => {
        const input = data.toString();

        if (input === '\x03') {
            stream.end();
        } else if (input === 'w' || input === '\x1B[A') {
            moveUp();
        } else if (input === 'a' || input === '\x1B[D') {
            moveLeft();
        } else if (input === 's' || input === '\x1B[B') {
            moveDown();
        } else if (input === 'd' || input === '\x1B[C') {
            moveRight();
        }

        if (isGameOver()) {
            printGrid();
            stream.write('Game over!\r\n');
            stream.end();
        } else {
            printGrid();
        }
    });

    addRandomTile();
    addRandomTile();
    printGrid();
}


function startConnectFourGame(stream) {
    const rows = 6;
    const columns = 7;
    let selector = 0;
    let board = Array.from({ length: rows }, () => Array(columns).fill(0));
    let currentPlayer = 1;

    function printBoard(winningTokens = [], aiNextMove = null) {
        stream.write('\x1Bc');
        board.forEach((row, rowIndex) => {
            stream.write(row.map((cell, colIndex) => {
                const isWinningToken = winningTokens.some(([r, c]) => r === rowIndex && c === colIndex);
                const isAiNextMove = aiNextMove === colIndex && rowIndex === getNextOpenRow(colIndex);
                if (cell === 0) {
                    return colIndex === selector ? chalk.bgRgb(30, 30, 30)(isAiNextMove ? chalk.yellow('?') : '.') : isAiNextMove ? chalk.yellow('?') : '.';
                } else if (cell === 1) {
                    return isWinningToken ? chalk.bgRed.white('O') :
                        colIndex === selector ?
                            chalk.bgRgb(20, 20, 20).red('O') : chalk.red('O');
                } else {
                    return isWinningToken ? chalk.bgBlue.white('O') :
                        colIndex === selector ?
                            chalk.bgRgb(20, 20, 20).blue('O') : chalk.blue('O');
                }
            }).join(' ') + '\r\n');
        });

        stream.write('0 1 2 3 4 5 6\r\n');
        stream.write(' '.repeat(selector * 2) + '^\r\n');
    }


    function dropToken(col) {
        for (let row = rows - 1; row >= 0; row--) {
            if (board[row][col] === 0) {
                board[row][col] = currentPlayer;
                return true;
            }
        }
        return false;
    }

    function checkWin(player) {
        return checkVertical(player) || checkHorizontal(player) || checkDiagonal(player);
    }



    function checkVertical(player) {
        for (let col = 0; col < columns; col++) {
            let count = 0;
            let winningTokens = [];
            for (let row = 0; row < rows; row++) {
                if (board[row][col] === player) {
                    count++;
                    winningTokens.push([row, col]);
                    if (count >= 4) {
                        return winningTokens;
                    }
                } else {
                    count = 0;
                    winningTokens = [];
                }
            }
        }
        return null;
    }

    function checkHorizontal(player) {
        for (let row = 0; row < rows; row++) {
            let count = 0;
            let winningTokens = [];
            for (let col = 0; col < columns; col++) {
                if (board[row][col] === player) {
                    count++;
                    winningTokens.push([row, col]);
                    if (count >= 4) {
                        return winningTokens;
                    }
                } else {
                    count = 0;
                    winningTokens = [];
                }
            }
        }
        return null;
    }



    function checkDiagonal(player) {
        for (let row = 0; row < rows - 3; row++) {
            for (let col = 0; col < columns; col++) {
                let winningTokens = [];
                if (col <= columns - 4) {
                    if (board[row][col] === player && board[row + 1][col + 1] === player &&
                        board[row + 2][col + 2] === player && board[row + 3][col + 3] === player) {
                        winningTokens.push([row, col], [row + 1, col + 1], [row + 2, col + 2], [row + 3, col + 3]);
                        return winningTokens;
                    }
                }
                if (col >= 3) {
                    if (board[row][col] === player && board[row + 1][col - 1] === player &&
                        board[row + 2][col - 2] === player && board[row + 3][col - 3] === player) {
                        winningTokens.push([row, col], [row + 1, col - 1], [row + 2, col - 2], [row + 3, col - 3]);
                        return winningTokens;
                    }
                }
            }
        }
        return null;
    }


    function checkTie() {
        return board.every(row => row.every(cell => cell !== 0));
    }

    function getValidColumns() {
        const validColumns = [];
        for (let col = 0; col < columns; col++) {
            if (board[0][col] === 0) validColumns.push(col);
        }
        return validColumns;
    }

    stream.on('data', (data) => {
        const input = data.toString();
        if (input === '\x03') {
            stream.end();
        } else if (input === 'a' || input === '\x1B[D') {
            selector = Math.max(selector - 1, 0);
        } else if (input === 'd' || input === '\x1B[C') {
            selector = Math.min(selector + 1, columns - 1);
        } else if (input === ' ' || input === '\r') {
            if (dropToken(selector)) {
                const winningTokens = checkWin(currentPlayer);
                if (winningTokens) {
                    printBoard(winningTokens);
                    stream.write(chalk.green(`Player ${currentPlayer} wins!\r\n`));
                    stream.end();
                } else if (checkTie()) {
                    printBoard();
                    stream.write(chalk.yellow('It\'s a tie!\r\n'));
                    stream.end();
                } else {
                    currentPlayer = 3 - currentPlayer;
                    aiMove();
                }
            }
        } else if (input === 'm') {
            hintForPlayer();
        } else if (input === 'h') {

            var tBoard = JSON.parse(JSON.stringify(board));
            var col = selector

            for (let row = rows - 1; row >= 0; row--) {
                if (tBoard[row][col] === 0) {
                    tBoard[row][col] = 3 - currentPlayer

                    break;
                }
            }

            var [nextMove, _] = minimax(tBoard, 4, -Infinity, Infinity, true);

            printBoard([], nextMove);

        }
        printBoard();
    });

    function hintForPlayer() {
        const depth = 4;
        const [suggestedColumn, _] = minimax(board, depth, -Infinity, Infinity, true);
        if (suggestedColumn !== null) {
            selector = suggestedColumn;
        }
    }



    function minimax(board, depth, alpha, beta, maximizingPlayer) {
        const validColumns = getValidColumns();
        const isTerminal = validColumns.length === 0 || depth === 0;

        if (isTerminal) {
            if (depth === 0 || validColumns.length === 0) {
                return [null, evaluateBoard()];
            }
            if (currentPlayerWins(1)) {
                return [null, -1000];
            }
            if (currentPlayerWins(2)) {
                return [null, 1000];
            }
        }

        if (maximizingPlayer) {
            let value = -Infinity;
            let column = validColumns[Math.floor(Math.random() * validColumns.length)];
            for (let col of validColumns) {
                const row = getNextOpenRow(col);
                if (row !== null) {
                    board[row][col] = 2;
                    let newScore = minimax(board, depth - 1, alpha, beta, false)[1];
                    board[row][col] = 0;
                    if (newScore > value) {
                        value = newScore;
                        column = col;
                    }
                    alpha = Math.max(alpha, value);
                    if (alpha >= beta) {
                        break;
                    }
                }
            }
            return [column, value];
        } else {
            let value = Infinity;
            let column = validColumns[Math.floor(Math.random() * validColumns.length)];
            for (let col of validColumns) {
                const row = getNextOpenRow(col);
                if (row !== null) {
                    board[row][col] = 1;
                    let newScore = minimax(board, depth - 1, alpha, beta, true)[1];
                    board[row][col] = 0;
                    if (newScore < value) {
                        value = newScore;
                        column = col;
                    }
                    beta = Math.min(beta, value);
                    if (alpha >= beta) {
                        break;
                    }
                }
            }
            return [column, value];
        }
    }

    function evaluateBoard() {
        let score = 0;

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < columns - 3; col++) {
                score += evaluateSegment([board[row][col], board[row][col + 1], board[row][col + 2], board[row][col + 3]]);
            }
        }

        for (let row = 0; row < rows - 3; row++) {
            for (let col = 0; col < columns; col++) {
                score += evaluateSegment([board[row][col], board[row + 1][col], board[row + 2][col], board[row + 3][col]]);
            }
        }

        for (let row = 0; row < rows - 3; row++) {
            for (let col = 0; col < columns - 3; col++) {
                score += evaluateSegment([board[row][col], board[row + 1][col + 1], board[row + 2][col + 2], board[row + 3][col + 3]]);
            }
        }

        for (let row = 0; row < rows - 3; row++) {
            for (let col = 3; col < columns; col++) {
                score += evaluateSegment([board[row][col], board[row + 1][col - 1], board[row + 2][col - 2], board[row + 3][col - 3]]);
            }
        }

        return score;
    }

    function evaluateSegment(segment) {
        let score = 0;
        let playerCount = 0;
        let aiCount = 0;
        let emptyCount = 0;

        for (let cell of segment) {
            if (cell === 1) {
                playerCount++;
            } else if (cell === 2) {
                aiCount++;
            } else {
                emptyCount++;
            }
        }

        if (aiCount === 4) {
            score += 100;
        } else if (aiCount === 3 && emptyCount === 1) {
            score += 10;
        } else if (aiCount === 2 && emptyCount === 2) {
            score += 5;
        }

        if (playerCount === 4) {
            score -= 100;
        } else if (playerCount === 3 && emptyCount === 1) {
            score -= 10;
        } else if (playerCount === 2 && emptyCount === 2) {
            score -= 5;
        }

        return score;
    }

    function aiMove() {
        const depth = 4;
        const [col, _] = minimax(board, depth, -Infinity, Infinity, true);
        if (col !== null) {
            dropToken(col);
            const winningTokens = checkWin(currentPlayer);
            if (winningTokens) {
                printBoard(winningTokens);
                stream.write(chalk.blue(`AI wins!\r\n`));
                stream.end();
            } else if (checkTie()) {
                printBoard();
                stream.write(chalk.yellow('It\'s a tie!\r\n'));
                stream.end();
            } else {
                currentPlayer = 3 - currentPlayer;

            }
        }
    }

    function getNextOpenRow(col) {
        for (let row = rows - 1; row >= 0; row--) {
            if (board[row][col] === 0) {
                return row;
            }
        }
        return null;
    }

    function currentPlayerWins(player) {
        return checkWin(player);
    }

    printBoard();

}

function startSnakeGame(stream) {
    const width = 20;
    const height = 10;

    let directionsQueue = [];

    const directions = {
        'w': { x: 0, y: -1 },
        'a': { x: -1, y: 0 },
        's': { x: 0, y: 1 },
        'd': { x: 1, y: 0 }
    };

    let snake = [{ x: Math.floor(width / 2), y: Math.floor(height / 2) }];
    let food = spawnFood();
    let currentDirection = 'd';
    let gameOver = false;

    function spawnFood() {
        let foodPosition;
        do {
            foodPosition = {
                x: Math.floor(Math.random() * width),
                y: Math.floor(Math.random() * height)
            };
        } while (snake.some(segment => segment.x === foodPosition.x && segment.y === foodPosition.y));
        return foodPosition;
    }

    function drawBoard(gameOver = false) {
        let board = '';
        let gameOverMessage = 'Game over     ';
        gameOverMessage = gameOverMessage.split('')
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (gameOver && y === Math.floor(height / 2) && x >= Math.floor(width / 2) - Math.floor(gameOverMessage.length / 2) && x < Math.floor(width / 2) + Math.floor(gameOverMessage.length / 2)) {
                    board += snake.some(segment => segment.x === x && segment.y === y) ? chalk.bgGreen(chalk.red(gameOverMessage.shift() + ' ')) : (food.x === x && food.y === y ? chalk.bgRed(gameOverMessage.shift() + ' ') : chalk.bgRgb(20, 20, 20)(chalk.red(gameOverMessage.shift() + ' ')));
                } else if (snake.some(segment => segment.x === x && segment.y === y)) {
                    board += chalk.bgGreen('  ');
                } else if (food.x === x && food.y === y) {
                    board += chalk.bgRed('  ');
                } else {
                    board += y % 2 === 0 ? x % 2 === 0 ?
                        (gameOver ? chalk.bgRgb(20, 20, 20)("  ") : chalk.bgRgb(30, 30, 30)("  ")) :
                        (gameOver ? chalk.bgRgb(20, 20, 20)("  ") : chalk.bgRgb(40, 40, 40)("  ")) :
                        x % 2 === 0 ?
                            (gameOver ? chalk.bgRgb(20, 20, 20)("  ") :
                                chalk.bgRgb(40, 40, 40)("  ")) :
                            (gameOver ? chalk.bgRgb(20, 20, 20)("  ") :
                                chalk.bgRgb(30, 30, 30)("  "));
                }

            }
            board += '\n';
        }
        stream.write('\x1Bc');
        stream.write(`Score: ${snake.length - 1} - Best: ${users.find(user => user.username === 'snake')?.stats?.best || 0}\r\n`);

        board.split('\n').forEach(line => stream.write(line + '\r\n'));
    }

    function updateSnake() {
        const newHead = {
            x: snake[0].x + directions[currentDirection].x,
            y: snake[0].y + directions[currentDirection].y
        };

        if (
            newHead.x < 0 || newHead.x >= width ||
            newHead.y < 0 || newHead.y >= height ||
            snake.some(segment => segment.x === newHead.x && segment.y === newHead.y)
        ) {
            gameOver = true;
            return;
        }

        snake.unshift(newHead);

        if (newHead.x === food.x && newHead.y === food.y) {
            food = spawnFood();
        } else {
            snake.pop();
        }
    }

    stream.on('data', (data) => {
        const input = data.toString()

        if (input === '\x03') {
            gameOver = true;
            return;
        }

        switch (input) {
            case 'w':
            case '\x1B[A':
                directionsQueue.push('w');
                break;
            case 'a':
            case '\x1B[D':
                directionsQueue.push('a');
                break;
            case 's':
            case '\x1B[B':
                directionsQueue.push('s');
                break;
            case 'd':
            case '\x1B[C':
                directionsQueue.push('d');
                break;
        }

    });

    function gameLoop() {
        if (gameOver) {
            stream.write('\x1Bc');
            var best = users.find(u => u.username === 'snake')?.stats?.best || 0;
            if (snake.length > best) {
                users.find(u => u.username === 'snake').stats = { best: snake.length }
            }
            drawBoard(true)
            stream.write('\x1B[31mGame over!\x1B[0m\n');
            stream.end();
            return;
        }
        directionsQueue = directionsQueue.filter(direction => {
            if (directions[direction].x + directions[currentDirection].x !== 0 || directions[direction].y + directions[currentDirection].y !== 0) {
                currentDirection = direction;
                return false;
            }
            return true;
        });
        drawBoard();
        updateSnake();
        setTimeout(gameLoop, 200);
    }

    gameLoop();
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

    let tempGame = {}

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
                    var content = "";
                    if (target === false || target === undefined || target.type === 'directory') {
                        return `cat: ${fileName}: No such file or directory\r\n`;
                    } else {
                        content = target
                    }

                    return content;
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
                var parsed = input.split(' ').splice(1);
                if (!parsed[parsed.length - 1] || parsed[parsed.length - 1].startsWith("-")) {
                    user = users.find(u => u.uid === currentUser).username;
                }
                if (parsed[1] == "--help" || parsed[1] == "-h") {
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
                user = users.find(u => u.username === user)

                function randomReadableColor() {
                    var r = Math.floor(Math.random() * 256);
                    var g = Math.floor(Math.random() * 256);
                    var b = Math.floor(Math.random() * 256);
                    if (r + g + b < 60) return randomReadableColor();
                    return [r, g, b]
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
                if (parsed[0] == "--commands" || parsed[0] == "-c") {
                    let commandStats = Object.keys(user.stats.commands).sort((a, b) => user.stats.commands[b] - user.stats.commands[a]).map(cmd => {
                        return `${cmd}:${' '.repeat(15 - cmd.length)}${user.stats.commands[cmd]} times`;
                    }).join('\r\n');

                    output = `Command statistics for ${user.username}: \r\n`
                    output += `Most used command: ${mostUsedCommand}\r\n`
                    output += `Total commands: ${totalCommands}\r\n`
                    output += `----------------------------------------\r\n`
                    output += `Commands:\r\n`
                    output += commandStats;

                } else if (parsed[0] == "--complete" || parsed[0] == "-all") {
                    output = `Statistics for user '${user.username}':
Total commands: ${totalCommands}
Most used command: ${mostUsedCommand}
Files created: ${userDB.stats.files}
Directories created: ${userDB.stats.directories}
Sudo commands: ${userDB.stats.sudo}
Time spent: ${formatMilliseconds(userDB.stats.uptime)}
Last login: ${userDB.stats.lastLogin.toLocaleString()}`;

                } else {
                    output = `Statistics for user '${user.username}':
Total commands: ${totalCommands}
Most used command: ${mostUsedCommand}
Files created: ${userDB.stats.files}
Time spent: ${formatMilliseconds(userDB.stats.uptime)}
Last login: ${userDB.stats.lastLogin.toLocaleString()}`;
                }

                var startColor = randomReadableColor();
                var endColor = randomReadableColor();

                const colorSteps = output.split('\n').length - 1;

                const colorFade = [];
                for (let i = 0; i <= colorSteps; i++) {
                    const r = Math.round(startColor[0] + (endColor[0] - startColor[0]) * (i / colorSteps));
                    const g = Math.round(startColor[1] + (endColor[1] - startColor[1]) * (i / colorSteps));
                    const b = Math.round(startColor[2] + (endColor[2] - startColor[2]) * (i / colorSteps));
                    colorFade.push([r, g, b]);
                }

                for (let i = 0; i < colorFade.length; i++) {
                    const color = colorFade[i];
                    shell.write(chalk.rgb(color[0], color[1], color[2])(output.split('\n')[i]) + '\r\n');
                }


                return "";

            }
        },
        {
            name: "alias",
            description: "Create an alias",
            root: false,
            execute: function (input, currentUser, shell) {
                var parts = input.split(' ');

                if (input.includes('--help') || input.includes('-h')) {
                    return `Usage: alias [options] [alias] [command]`
                }
                var bashAliases = fileSystemFunctions.readFileContent(`${userDB.home}/.bash_aliases`) || "";
                if (bashAliases) {
                    bashAliases = bashAliases.split('\n');
                    bashAliases.forEach((line, index) => {
                        if (line.split('=')[0] === parts[1]) {
                            return `alias: ${parts[1]}: alias already exists\r\n`;
                        }
                    })
                }
                if (parts.length < 3) {
                    return `alias: missing operand\r\n`;
                }
                var alias = parts[1];
                var command = "'" + parts.slice(2).join(' ') + "'";
                fileSystemFunctions.createFile(userDB, `${userDB.home}/.bash_aliases`, `${alias}=${command}\n`);
                return '';

            }
        },
        {
            name: "unalias",
            description: "Remove an alias",
            root: false,
            execute: function (input, currentUser, shell) {
                var alias = input.split(' ')[1];
                if (!alias) {
                    return `unalias: missing operand\r\n`;
                }
                var bashAliases = fileSystemFunctions.readFileContent(`${userDB.home}/.bash_aliases`) || "";
                if (bashAliases) {
                    bashAliases = bashAliases.split('\n');
                    var newAliases = bashAliases.filter(line => line.split('=')[0] !== alias).join('\n');
                    fileSystemFunctions.createFile(userDB, `${userDB.home}/.bash_aliases`, newAliases);
                }
                return '';
            }
        }, {
            name: "rockpaperscissors",
            description: "Play rock paper scissors",
            root: false,
            execute: function (input, currentUser, shell) {
                mode = "rockpaperscissors";
                shell.write('\x1B[2K');
                startRockPaperScissorsGame(shell, true)
              
                return false;
            }
        }
    ]

    client.on('authentication', (ctx) => {
        authCtx = ctx;

        console.log(client._sock.remoteAddress + ' is trying to authenticate with ' + ctx.method + ' method as ' + ctx.username);

        if (!ctx.username) return ctx.reject();
        if (ctx.username === 'rick') return ctx.accept();
        if (ctx.username === "clock") return ctx.accept();
        if (ctx.username === "connect4") return ctx.accept();
        if (ctx.username === "2048") return ctx.accept();
        if (ctx.username === "tictactoe") return ctx.accept();
        if (ctx.username === "rockpaperscissors") return ctx.accept();
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
                if (authCtx.username === 'rockpaperscissors') {
                    startRockPaperScissorsGame(shell);
                } else if (authCtx.username === 'tictactoe') {
                    startTicTacToeGame(shell);
                } else if (authCtx.username === '2048') {
                    start2048Game(shell);
                } else if (authCtx.username === 'connect4') {
                    startConnectFourGame(shell);
                } else if (authCtx.username == "snake") {
                    startSnakeGame(shell);
                } else if (authCtx.username === 'clock') {

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
                }  /*else if (authCtx.username != "exelv" && authCtx.username != "root" && authCtx.username != "exelvi") { //Random ips were trying to access the terminal
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

                }*/
                else {


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

                        console.log(mode)
                        if (mode === "rockpaperscissors") {
                          
                            let result = startRockPaperScissorsGame(shell, true, { input: data.toString(), ...tempGame?.rps })

                            if (!result) {
                                mode = "normal";
                                shell.write(`${userDB.uid == 0 ? '\x1B[31m' : '\x1B[32m'}${userDB.username}@${instanceName}\x1B[0m:\x1B[34m${currentDir}\x1B[0m${userDB.uid == 0 ? '#' : '$'} `);
                                return;
                            }

                            tempGame.rps = result;

                        } else {

                            var printableChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890!@#$%^&*()_+-=[]{}|;:,.<>?/\\\'"`~ \t\n\r';
                            if (!mode.startsWith("passwd") && !mode.startsWith("supassword") && !mode.startsWith("sudo")) {
                                if (printableChars.includes(data.toString())) {
                                    shell.write(data);
                                }
                            }

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

                                tabMachPosition = 0;
                                tabMachCommandPosition = 0;
                                first = true;
                            }
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