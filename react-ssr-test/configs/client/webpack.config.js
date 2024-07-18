const AssetsWebpackPlugin = require('assets-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const path = require('path');
const { DefinePlugin, ProgressPlugin } = require('webpack');
const { aliasReactToLocal } = require('../utils');

const MIN_CHUNKS = 2;
const WORKSPACE = path.resolve(__dirname, '../../');
const CACHE_DIRECTORY = path.resolve(WORKSPACE, 'node_modules/.webpackCache');
const CLIENT_DIST_DIRECTORY = path.resolve(WORKSPACE, 'dist');

const BASE_BABEL_CONFIG = {
  sourceType: 'unambiguous',
  presets: [
    // [
    //   '@babel/preset-env',
    //   {
    //     targets: {
    //       browsers: ['Android >= 4.4', 'iOS >= 9']
    //     },
    //     useBuiltIns: 'usage',
    //     modules: false,
    //     corejs: '2.0'
    //   }
    // ],
    '@babel/preset-react',
    '@babel/preset-flow',
    '@babel/preset-typescript'
  ],
  // plugins: ['react-refresh/babel']
  plugins: []
};

const webpackConfig = {
  name: 'development_client',
  mode: 'development',
  target: ['web', 'es5'],
  node: false,
  devtool: 'source-map',
  entry: {
    base: path.resolve(WORKSPACE, 'src/routes/base'),
    selective: path.resolve(WORKSPACE, 'src/routes/selective')
  },
  output: {
    path: CLIENT_DIST_DIRECTORY,
    filename: 'assets/js/[name]_[contenthash].js',
    chunkFilename: 'assets/js/[name]_[contenthash].js',
    publicPath: '/',
    chunkLoadTimeout: 10000,
    environment: {
      arrowFunction: false,
      bigIntLiteral: false,
      const: false,
      destructuring: false,
      dynamicImport: false,
      forOf: false,
      module: false
    }
  },
  externals: [],
  experiments: {
    lazyCompilation: {
      // enable lazy compilation for dynamic imports
      imports: true,
      // disable lazy compilation for entries
      entries: false
    }
  },
  resolve: {
    alias: aliasReactToLocal({
      '@': path.resolve(WORKSPACE, 'src')
    }),
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs', '.wasm', '.css']
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
          {
            loader: MiniCssExtractPlugin.loader,
            options: {
              esModule: false
            }
          },
          'css-loader',
          'postcss-loader'
        ]
      },
      {
        test: /\.(jpg|jpeg|png|gif)$/,
        type: 'asset/resource',
        generator: {
          filename: 'static/images/[hash][ext][query]'
        }
      }
    ]
  },
  plugins: [
    new DefinePlugin({
      'process.env': {
        BROWSER: JSON.stringify(true),
        BUNDLE_PLATFORM: JSON.stringify(process.env.platform)
      },
      __DEV__: true,
      __PROFILE__: true,
      __UMD__: true,
      __EXPERIMENTAL__: true,
      __VARIANT__: false
    }),
    new AssetsWebpackPlugin({
      path: CLIENT_DIST_DIRECTORY,
      filename: 'webpack-assets.json',
      entrypoints: true
    }),
    new MiniCssExtractPlugin({
      filename: 'assets/css/[name].css',
      chunkFilename: 'assets/css/[name].css'
    }),
    new ProgressPlugin({
      percentBy: 'modules'
    })
    // new ReactRefreshWebpackPlugin()
  ],
  optimization: {
    runtimeChunk: {
      name: 'webpack_runtime'
    },
    splitChunks: {
      name: (module, chunks, cacheGroupKey) => {
        // const moduleFileName = module
        //   .identifier()
        //   .split('/')
        //   .reduceRight((item) => item);
        const allChunksNames = chunks.map((item) => item.name).join('~');
        // return `${cacheGroupKey}-${allChunksNames}-${moduleFileName}`;
        return allChunksNames;
      },
      chunks: 'all',
      maxInitialRequests: 5,
      minRemainingSize: 0,
      cacheGroups: {
        initial_vendors: {
          name: 'vendors',
          test: /[\\/]node_modules[\\/]/,
          minChunks: MIN_CHUNKS,
          reuseExistingChunk: true
        },
        dynamic_vendors: {
          name: 'dynamic_vendors',
          test: /[\\/]node_modules[\\/]/,
          chunks: 'async',
          minChunks: MIN_CHUNKS,
          reuseExistingChunk: true,
          priority: 1
        }
      }
    }
  },
  cache: {
    name: 'cache_client_development',
    type: 'filesystem',
    buildDependencies: {
      config: [__filename]
    },
    cacheDirectory: CACHE_DIRECTORY
  }
};

module.exports = webpackConfig;
