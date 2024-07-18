const path = require('path');
const { ALIAS_REACT_PACKAGE_LIST, REACT_VERSION } = require('./setting');

const aliasReactToLocal = (aliasConfig) => {
  const newAliasConfig = { ...aliasConfig };

  for (const package of ALIAS_REACT_PACKAGE_LIST) {
    Object.assign(newAliasConfig, {
      [package]: path.resolve(
        process.cwd(),
        `../react/${REACT_VERSION}/${package}`
      )
    });
  }

  return newAliasConfig;
};

module.exports = { aliasReactToLocal };
