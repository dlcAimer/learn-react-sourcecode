const path = require('path');
const { DefinePlugin, ProgressPlugin } = require('webpack');
const { aliasReactToLocal } = require('../utils');

const WORKSPACE = path.resolve(__dirname, '../../');
const CACHE_DIRECTORY = path.resolve(WORKSPACE, 'node_modules/.webpackCache');

const BASE_BABEL_CONFIG = {
  sourceType: 'unambiguous',
  presets: [
    // [
    //   '@babel/preset-env',
    //   {
    //     targets: {
    //       node: 'current'
    //     },
    //     useBuiltIns: 'usage',
    //     modules: 'commonjs',
    //     corejs: '2.0'
    //   }
    // ],
    '@babel/preset-react',
    '@babel/preset-flow',
    '@babel/preset-typescript'
  ],
  plugins: []
};

function getNodeVersion() {
  return process.versions.node.split('.').slice(0, 2).join('.');
}

const webpackConfig = {
  name: 'development_server',
  mode: 'development',
  target: `node${getNodeVersion()}`,
  node: false,
  devtool: 'source-map',
  entry: {
    index: path.resolve(WORKSPACE, 'src/server/index')
  },
  output: {
    path: path.resolve(WORKSPACE, 'dist/server'),
    chunkFilename: '[id].chunk.js',
    publicPath: '/',
    library: {
      type: 'commonjs2'
    }
  },
  externals: [],
  experiments: {
    lazyCompilation: {
      // enable lazy compilation for dynamic imports
      imports: true,
      // disable lazy compilation for entries
      entries: false,
      // do not lazily compile moduleB
      test: (module) => !/lodash/.test(module.nameForCondition() || '')
    }
  },
  resolve: {
    alias: aliasReactToLocal({
      '@': path.resolve(WORKSPACE, 'src')
    }),
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs', '.wasm', '.css'],
    symlinks: true
  },
  module: {
    parser: {
      javascript: {
        exportsPresence: 'error'
      }
    },
    rules: [
      {
        test: /\.(js|jsx|ts|tsx)$/,
        exclude: /node_modules/,
        use: [
          'thread-loader',
          { loader: 'babel-loader', options: BASE_BABEL_CONFIG }
        ]
      },
      {
        test: /\.css$/,
        // module css 需要额外处理
        exclude: /\.module\.css$/,
        use: [
          'css-loader',
          'postcss-loader'
        ]
      },
      {
        test: /\.(jpg|jpeg|png|gif)$/,
        type: 'asset/resource',
        generator: {
          // 服务端构建不输出资源
          emit: false,
          filename: 'static/images/[hash][ext][query]'
        }
      }
    ]
  },
  plugins: [
    new DefinePlugin({
      'process.env': { BROWSER: false },
      __DEV__: true,
      __PROFILE__: true,
      __UMD__: true,
      __EXPERIMENTAL__: true,
      __VARIANT__: false
    }),
    new ProgressPlugin({
      percentBy: 'modules'
    })
  ],
  cache: {
    name: 'cache_server_development',
    type: 'filesystem',
    buildDependencies: {
      config: [__filename]
    },
    cacheDirectory: CACHE_DIRECTORY
  }
};

module.exports = webpackConfig;
