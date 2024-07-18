const fs = require('fs');
const path = require('path');
const express = require('express');
const webpack = require('webpack');
const WEBPACK_CONFIG = require('../configs/webpack.config');

const compiler = webpack(WEBPACK_CONFIG);

compiler.run((error, stats) => {
  if (error || stats.hasErrors()) {
    return;
  }

  console.log(stats.toString());

  const app = express();

  app.use(express.static(path.resolve(process.cwd(), './dist')));
  app.use('/index.html', (req, res, next) => {
    const filePath = path.resolve(process.cwd(), './src/pages/index.html');
    const content = fs.readFileSync(filePath, {
      encoding: 'utf-8'
    });
    res.send(content);
  });

  app.listen(3031, () => {
    console.log('server started');
  });
});
