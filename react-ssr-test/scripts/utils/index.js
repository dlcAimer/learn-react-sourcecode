const fs = require('fs');

/** 清空文件夹 */
const cleanDirectory = (path) => {
  try {
    if (fs.existsSync(path)) {
      fs.rmSync(path, { recursive: true });
    }

    fs.mkdirSync(path, { recursive: true });
    return true;
  } catch (error) {
    return false;
  }
};

module.exports = {
  cleanDirectory
};
