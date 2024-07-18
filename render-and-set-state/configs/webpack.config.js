const path = require('path');

const WEBPACK_CONFIG = {
  name: 'render-and-set-state',
  mode: 'development',
  entry: {
    index: path.resolve(process.cwd(), './src/components/index.jsx')
  },
  output: {
    path: path.resolve(process.cwd(), 'dist'),
    publicPath: '',
    filename: 'assets/js/[name].js'
  },
  devtool: 'source-map',
  module: {
    strictExportPresence: true,
    rules: [
      {
        test: /\.(js|jsx|ts|tsx)$/,
        exclude: /node_modules[\\/](@babel)|(react)/,
        use: [
          {
            loader: 'babel-loader',
            options: {
              sourceType: 'unambiguous',
              presets: ['@babel/preset-react']
            }
          }
        ]
      }
    ]
  },
  resolve: {
    extensions: ['.js', '.jsx', '.json', '.mjs', '.wasm', '.ts', '.tsx']
  }
};

module.exports = WEBPACK_CONFIG;
