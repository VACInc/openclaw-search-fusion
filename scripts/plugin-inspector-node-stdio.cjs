const fs = require("node:fs");

function makeWritesSynchronous(stream, fd) {
  if (!stream || typeof stream._write !== "function") return;
  stream._write = (chunk, encoding, callback) => {
    try {
      if (Buffer.isBuffer(chunk)) fs.writeSync(fd, chunk);
      else fs.writeSync(fd, String(chunk), undefined, encoding);
      callback();
    } catch (error) {
      callback(error);
    }
  };
}

makeWritesSynchronous(process.stdout, 1);
makeWritesSynchronous(process.stderr, 2);
