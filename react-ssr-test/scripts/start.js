const path = require('path');
const webpack = require('webpack');
const SERVER_WEBPACK_CONFIG = require('../configs/server/webpack.config');
const CLIENT_WEBPACK_CONFIG = require('../configs/client/webpack.config');
const { cleanDirectory } = require('./utils/index.js');

const createController = () => {
  let _resolve = () => {};
  let _reject = () => {};
  const promise = new Promise((resolve, reject) => {
    _resolve = resolve;
    _reject = reject;
  });

  return {
    promise,
    resolve: _resolve,
    reject: _reject
  };
};

const startCompiler = (webpackConfig, controller) => {
  const compiler = webpack(webpackConfig);

  compiler.run((error, stats) => {
    if (error) {
      console.error('error: ', error);
      return;
    }

    if (stats.hasErrors()) {
      console.error('stats has errors:', stats.toString());
      return;
    }

    console.log(stats.toString());
    controller.resolve();
  });
};

cleanDirectory(path.resolve(__dirname, '../dist'));

const clientController = createController();
const serverController = createController();

startCompiler(CLIENT_WEBPACK_CONFIG, clientController);
startCompiler(SERVER_WEBPACK_CONFIG, serverController);

Promise.all([clientController.promise, serverController.promise]).then(() => {
  const startServer = require(path.resolve(
    __dirname,
    '../dist/server/index'
  )).default;
  startServer();
});
