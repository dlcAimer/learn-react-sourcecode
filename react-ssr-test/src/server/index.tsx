import * as React from 'react';

import express from 'express';
import fs from 'fs';
import path from 'path';
import * as ReactDomServer from 'react-dom/server';

import Base from '../pages/base';
import Selective from '../pages/selective';

interface IAssets {
  [route: string]: {
    js: string[];
    css?: string[];
  };
}

const htmlTemplate = (content: string, scripts: string, styles: string) =>
  `<!DOCTYPE html><html><head>${styles}</head><body><div id="root">${content}</div>${scripts}</body></html>`;

const scriptsTemplate = (assets: IAssets, route: string) => {
  const jsList = assets[route].js;
  return jsList.reduce(
    (result, link) =>
      (result += `<script src="${link}" crossorigin="anonymous"></script>`),
    ''
  );
};

const stylesTemplate = (assets: IAssets, route: string) => {
  const sourceValue = assets[route].css;
  const cssList = typeof sourceValue === 'string' ? [sourceValue] : sourceValue;

  if (!cssList.length) {
    return '';
  }

  return cssList.reduce(
    (result, link) =>
      (result += `<link rel="stylesheet" type="text/css" href="${link}" crossorigin="anonymous"></link>`),
    ''
  );
};

const startServer = () => {
  const app = express();
  const assets = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../webpack-assets.json'), {
      encoding: 'utf-8'
    })
  ) as IAssets;

  app.use(express.static(path.resolve(__dirname, '../')));

  /** 基础水合 */
  app.use('/base.html', (req, res, next) => {
    const scripts = scriptsTemplate(assets, 'base');
    const styles = stylesTemplate(assets, 'base');
    const app = <Base />;
    const content = ReactDomServer.renderToString(app);
    res.send(htmlTemplate(content, scripts, styles));
  });

  /** selective 水合 */
  app.use('/selective.html', (req, res, next) => {
    let hasError = false;
    const scripts = scriptsTemplate(assets, 'selective');
    const styles = stylesTemplate(assets, 'selective');
    res.write(`<!DOCTYPE html><html><head>${styles}</head><body><div id="root">`);
    const app = <Selective />;
    const { pipe, abort } = ReactDomServer.renderToPipeableStream(app, {
      onCompleteShell() {
        console.log('11111111');
        // res.statusCode = hasError ? 500 : 200;
        res.setHeader("Content-type", "text/html");
        pipe(res);
      },
      onErrorShell(error) {
        console.error(error);
        res.write(`</div>${scripts}</body></html>`);
      },
      onError(error) {
        hasError = true;
        console.error(error);
      }
    });
  });

  app.listen(3031, () => {
    console.log('server started');
  });
};

export default startServer;
