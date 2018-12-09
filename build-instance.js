var t0 = Date.now();

const fs = require('fs');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');

function sendResult(result) {
    try {
        process.stdout.write(result);
    } catch (err) {
        process.stdout.write(err.stack.toString());
    }
}

const stdinBuffer = fs.readFileSync(0);
const firstLine = stdinBuffer.indexOf(10);
const secondLine = stdinBuffer.indexOf(10, firstLine + 1);
const infoString = stdinBuffer.slice(0, firstLine).toString();
const info = JSON.parse(infoString);
const argsString = stdinBuffer.slice(firstLine + 1, secondLine).toString();
const args = JSON.parse(argsString);
const program = JSON.parse(stdinBuffer.slice(secondLine + 1).toString());

const startTime = info.time;

try {

    var target = args.platform + "-" + args.arch + "-" + args.target + "/" + crypto.createHash('sha256').update(program).digest('hex');

    process.chdir('./ispc/build');

    if (!fs.existsSync(`./targets/${target}/program`)) {
        if (!fs.existsSync(`./targets/${target}`)) {
            execFileSync('mkdir', ['-p', `./targets/${target}`]);
        }
        const arch = /^arm/.test(args.arch) ? 'arm' : args.arch;
        const bits = arch === 'arm' ? '32' : '64';
        const ispc = args.arch === 'aarch64' ? 'ispc-aarch64' : 'ispc';
        fs.writeFileSync(`./targets/${target}/program.ispc`, program);
        execFileSync('/usr/bin/make', [
            'ispc',
            `ISPC=${ispc}`, 
            `BITS=${bits}`,
            `PLATFORM=${args.platform}`,
            `ARCH=${arch}`,
            `FLAGS=--arch=${arch} --target=${args.target} --addressing=${args.addressing}`,
            `TARGET=${target}`
        ]);
    }

    const output = fs.readFileSync(`./targets/${target}/program.o`);

    var t1 = Date.now();

    process.stdout.write("application/x-object\n");
    sendResult(output);


} catch (e) {

    sendResult(e.stack.toString());

}
