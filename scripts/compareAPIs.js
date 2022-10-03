
let fs = require('fs-extra');
let fg = require('fast-glob');
let path = require('path');
let changesets = require('json-diff-ts');
let util = require('util');
let {walkObject} = require('walk-object');
let chalk = require('chalk');
let yargs = require('yargs');
let Diff = require('diff');

let argv = yargs
  .option('verbose', {alias: 'v', type: 'boolean'})
  .option('organizedBy', {choices: ['type', 'change']})
  .option('rawNames', {type: 'boolean'})
  .option('package', {type: 'string'})
  .argv;

compare().catch(err => {
  console.error(err.stack);
  process.exit(1);
});

/**
 * This takes the json files generated by the buildBranchAPI and buildPublishedAPI and diffs each of the corresponding
 * json files. It outputs a JSON string that tells if each property is an addition, removal, or addition to the API.
 * From this, we can determine if we've made a breaking change or introduced an API we meant to be private.
 * We can high level some of this information in a series of summary messages that are color coded at the tail of the run.
 */
async function compare() {
  let branchDir = path.join(__dirname, '..', 'dist', 'branch-api');
  let publishedDir = path.join(__dirname, '..', 'dist', 'published-api');
  if (!(fs.existsSync(branchDir) && fs.existsSync(publishedDir))) {
    console.log(chalk.redBright(`you must have both a branchDir ${branchDir} and publishedDir ${publishedDir}`));
    return;
  }
  let summaryMessages = [];

  let branchAPIs = fg.sync(`${branchDir}/**/api.json`);
  let publishedAPIs = fg.sync(`${publishedDir}/**/api.json`);
  let pairs = [];
  // we only care about changes to already published APIs, so find all matching pairs based on what's been published
  for (let pubApi of publishedAPIs) {
    let pubApiPath = pubApi.split(path.sep);
    let sharedPath = path.join(...pubApiPath.slice(pubApiPath.length - 4));
    let matchingBranchFile;
    for (let branchApi of branchAPIs) {
      if (branchApi.includes(sharedPath)) {
        matchingBranchFile = branchApi;
        pairs.push({pubApi, branchApi});
        break;
      }
    }
    if (!matchingBranchFile) {
      summaryMessages.push({msg: `removed module ${pubApi}`, severity: 'error'});
    }
  }
  let privatePackages = [];
  // don't care about not private APIs, but we do care if we're about to publish a new one
  for (let branchApi of branchAPIs) {
    let branchApiPath = branchApi.split(path.sep);
    let sharedPath = path.join(...branchApiPath.slice(branchApiPath.length - 4));
    let matchingPubFile;
    for (let pubApi of publishedAPIs) {
      if (pubApi.includes(sharedPath)) {
        matchingPubFile = pubApi;
        // don't re-add to pairs
        break;
      }
    }
    if (!matchingPubFile) {
      let json = JSON.parse(fs.readFileSync(path.join(branchApi, '..', '..', 'package.json')), 'utf8');
      if (!json.private) {
        summaryMessages.push({msg: `added module ${branchApi}`, severity: 'warn'});
      } else {
        privatePackages.push(branchApi);
      }
    }
  }

  let count = 0;
  let diffs = {};
  for (let pair of pairs) {
    let diff = getDiff(summaryMessages, pair);
    // console.log(diff);
    // if (diff.diff.length > 0) {
    //   count += 1;
    //   diffs[diff.name] = diff.diff;
    // }
  }
  return;
  let modulesAdded = branchAPIs.length - privatePackages.length - publishedAPIs.length;
  if (modulesAdded !== 0) {
    summaryMessages.push({msg: `${Math.abs(modulesAdded)} modules ${modulesAdded > 0 ? 'added' : 'removed'}`, severity: modulesAdded > 0 ? 'warn' : 'error'});
  } else {
    summaryMessages.push({msg: 'no modules removed or added', severity: 'info'});
  }
  if (count !== 0) {
    summaryMessages.push({msg: `${count} modules had changes to their API ${Object.keys(diffs).map(key => `\n  - ${simplifyModuleName(key)}`)}`, severity: 'warn'});
  } else {
    summaryMessages.push({msg: 'no modules changed their API', severity: 'info'});
  }
  summaryMessages.push({});
  let matches = analyzeDiffs(diffs);
  let moreMessages = generateMessages(matches);
  [...summaryMessages, ...moreMessages].forEach(({msg, severity}) => {
    if (!msg) {
      console.log('');
      return;
    }
    let color = 'default';
    switch (severity) {
      case 'info':
        color = 'greenBright';
        break;
      case 'log':
        color = 'blueBright';
        break;
      case 'warn':
        color = 'yellowBright';
        break;
      case 'error':
        color = 'redBright';
        break;
      default:
        color = 'defaultBright';
        break;
    }
    console[severity](chalk[color](msg));
  });
}

function getDiff(summaryMessages, pair) {
  let name = pair.branchApi.replace(/.*branch-api/, '');
  if (argv.package && name !== argv.package) {
    return {diff: {}, name};
  }
  console.log(`diffing ${name}`);
  let publishedApi = fs.readJsonSync(pair.pubApi);
  let branchApi = fs.readJsonSync(pair.branchApi);
  let publishedInterfaces = rebuildInterfaces(publishedApi);
  let branchInterfaces = rebuildInterfaces(branchApi);
  //console.log(publishedInterfaces)
  //console.log(branchInterfaces)
  let codeDiff = Diff.createPatch(name, JSON.stringify(publishedInterfaces, null, 2), JSON.stringify(branchInterfaces, null, 2));
  let diff = changesets.diff(publishedInterfaces, branchInterfaces);
  if (diff.length > 0 && argv.verbose) {
    console.log(`diff found in ${name}`);
    console.log(util.inspect(codeDiff, {depth: null}));
    // for now print the whole diff
    // console.log(util.inspect(diff, {depth: null}));
  }
  return {diff, name};
  // walkObject(publishedApi, ({value, location, isLeaf}) => {
  //   if (!isLeaf && value.id && typeof value.id === 'string') {
  //     value.id = value.id.replace(/.*(node_modules|packages)/, '');
  //   }
  // });
  // let branchApi = fs.readJsonSync(pair.branchApi);
  // delete branchApi.links;
  // walkObject(branchApi, ({value, location, isLeaf}) => {
  //   if (!isLeaf && value.id && typeof value.id === 'string') {
  //     value.id = value.id.replace(/.*(node_modules|packages)/, '');
  //   }
  // });
  // let diff = changesets.diff(publishedApi, branchApi);
  // if (diff.length > 0 && argv.verbose) {
  //   console.log(`diff found in ${name}`);
  //   // for now print the whole diff
  //   console.log(util.inspect(diff, {depth: null}));
  // }
  //
  // let publishedExports = publishedApi.exports;
  // let branchExports = branchApi.exports;
  // let addedExports = Object.keys(branchExports).filter(key => !publishedExports[key]);
  // let removedExports = Object.keys(publishedExports).filter(key => !branchExports[key]);
  // if (addedExports.length > 0) {
  //   summaryMessages.push({msg: `added exports ${addedExports} to ${pair.branchApi}`, severity: 'warn'});
  // }
  // if (removedExports.length > 0) {
  //   summaryMessages.push({msg: `removed exports ${removedExports} from ${pair.branchApi}`, severity: 'error'});
  // }
  // return {diff, name};
}

function analyzeDiffs(diffs) {
  let matches = new Map();
  let used = new Map();
  for (let [key, value] of Object.entries(diffs)) {
    walkChanges(value, {
      UPDATE: (change, path) => {
        if (used.has(change) || !(change.key === 'type' && (change.value === 'link' || change.oldValue === 'link'))) {
          return;
        }
        matches.set(change, [`${key}:${path}`]);
        used.set(change, true);
        for (let [name, diff] of Object.entries(diffs)) {
          walkChanges(diff, {
            UPDATE: (addChange, addPath) => {
              let subDiff = changesets.diff(addChange, change);
              if (subDiff.length === 0) {
                // guaranteed to have the match because we added it before doing this walk
                let match = matches.get(change);
                if (name !== key && !used.has(addChange)) {
                  match.push(`${name}:${addPath}`);
                  used.set(addChange, true);
                }
              }
            }
          });
        }
      },
      ADD: (change, path) => {
        if (used.has(change)) {
          return;
        }
        matches.set(change, [`${key}:${path}`]);
        used.set(change, true);
        for (let [name, diff] of Object.entries(diffs)) {
          walkChanges(diff, {
            ADD: (addChange, addPath) => {
              let subDiff = changesets.diff(addChange, change);
              if (subDiff.length === 0) {
                // guaranteed to have the match because we added it before doing this walk
                let match = matches.get(change);
                if (name !== key && !used.has(addChange)) {
                  match.push(`${name}:${addPath}`);
                  used.set(addChange, true);
                }
              }
            }
          });
        }
      },
      REMOVE: (change, path) => {
        if (used.has(change)) {
          return;
        }
        matches.set(change, [`${key}:${path}`]);
        used.set(change, true);
        for (let [name, diff] of Object.entries(diffs)) {
          walkChanges(diff, {
            REMOVE: (addChange, addPath) => {
              let subDiff = changesets.diff(addChange, change);
              if (subDiff.length === 0) {
                // guaranteed to have the match because we added it before doing this walk
                let match = matches.get(change);
                if (name !== key && !used.has(addChange)) {
                  match.push(`${name}:${addPath}`);
                  used.set(addChange, true);
                }
              }
            }
          });
        }
      }
    });
  }
  return matches;
}

// Recursively walks a json object and calls a processing function on each node based on its type ["ADD", "REMOVE", "UPDATE"]
// tracks the path it's taken through the json object and passes that to the processing function
function walkChanges(changes, process, path = '') {
  for (let change of changes) {
    if (process[change.type]) {
      process[change.type](change, path);
    }
    if (change.changes && change.changes.length >= 0) {
      walkChanges(change.changes, process, `${path}${path.length > 0 ? `.${change.key}` : change.key}`);
    }
  }
}

function generateMessages(matches) {
  let summaryMessages = [];

  if (argv.organizedBy === 'change') {
    for (let [key, value] of matches) {
      /** matches
       * {"identifier UPDATED to link": ["/@react-aria/i18n:exports.useDateFormatter.return", "/@react-aria/textfield:exports.useTextField.parameters.1.value.base"]}
       */
      let targets = value.map(loc => simplifyModuleName(loc)).map(loc => {
        if (!argv.rawNames) {
          return `\n  - ${loc.split(':')[0]}:${getRealName(loc, loc.split(':')[1])}`;
        } else {
          return `\n  - ${loc}`;
        }
      });
      let severity = 'log';
      let message = `${key.key} ${key.type} to:${targets}`;
      if (key.type === 'REMOVE') {
        message = `${key.key} ${key.type} from:${targets}`;
        severity = 'warn';
      }
      if (key.type === 'UPDATE') {
        message = `${key.oldValue} UPDATED to ${key.value}:${targets}`;
      }
      summaryMessages.push({msg: message, severity});
    }
  } else {
    let invertedMap = new Map();
    /** invertedMap
     * {"/@react-aria/i18n:exports.useDateFormatter.return": ["identifier UPDATED to link"],
     *  "exports.useTextField.parameters.1.value.base": ["identifier UPDATED to link"]}
     */
    for (let [key, value] of matches) {
      for (let loc of value.map(simplifyModuleName)) {
        let entry = invertedMap.get(loc);
        if (entry) {
          entry.push(key);
        } else {
          invertedMap.set(loc, [key]);
        }
      }
    }

    for (let [key, value] of invertedMap) {
      let realName = getRealName(key);
      let targets = value.map(change => {
        let message = '';
        switch (change.type) {
          case 'REMOVE':
            message = chalk.redBright(`${change.key} ${change.type}D`);
            break;
          case 'UPDATE':
            message = `${change.oldValue} UPDATED to ${change.value}`;
            break;
          default:
            message = `${change.key} ${change.type}ED`;
            break;
        }
        return `\n  - ${message}`;
      });
      let severity = 'log';
      if (!argv.rawNames) {
        summaryMessages.push({msg: `${key.split(':')[0]}:${realName}${targets}`, severity});
      } else {
        summaryMessages.push({msg: `${key}${targets}`, severity});
      }
    }
  }
  return summaryMessages;
}

/**
 * Looks up the path through the json object and tries to replace hard to read values with easier to read ones
 * @param diffName - /@react-aria/textfield:exports.useTextField.parameters.1.value.base
 * @param type - ["ADD", "REMOVE", "UPDATE"]
 * @returns {string} - /@react-aria/textfield:exports.useTextField.parameters.ref.value.base
 */
function getRealName(diffName, type = 'ADD') {
  let [file, jsonPath] = diffName.split(':');
  let filePath = path.join(__dirname, '..', 'dist', type === 'REMOVE' ? 'published-api' : 'branch-api', file, 'dist', 'api.json');
  let json = JSON.parse(fs.readFileSync(filePath), 'utf8');
  let name = [];
  for (let property of jsonPath.split('.')) {
    json = json[property];
    name.push(json.name ?? property);
  }
  return name.join('.');
}

function simplifyModuleName(apiJsonPath) {
  return apiJsonPath.replace(/\/dist\/.*\.json/, '');
}

function processType(value) {
  if (!value) {
    return 'UNTYPED';
  }
  if (Object.keys(value).length === 0) {
    return '{}';
  }
  if (value.type === 'union') {
    return value.elements.map(processType).join(' | ');
  }
  if (value.type === 'intersection') {
    return `(${value.types.map(processType).join(' & ')})`;
  }
  if (value.type === 'array') {
    return `Array<${processType(value.elementType)}>`;
  }
  if (value.type === 'tuple') {
    return `[${value.elements.map(processType).join(', ')}]`;
  }
  if (value.type === 'string') {
    if (value.value) {
      return `'${value.value}'`;
    }
    return 'string';
  }
  if (value.type === 'parameter') {
    return processType(value.value);
  }
  if (value.type === 'keyof') {
    return `keyof ${processType(value.keyof)}`;
  }
  if (value.type === 'any') {
    return 'any';
  }
  if (value.type === 'unknown') {
    return 'unknown';
  }
  if (value.type === 'object') {
    return '{}';
  }
  if (value.type === 'symbol') {
    return 'symbol';
  }
  if (value.type === 'null') {
    return 'null';
  }
  if (value.type === 'undefined') {
    return 'undefined';
  }
  if (value.type === 'number') {
    return 'number';
  }
  if (value.type === 'boolean') {
    return 'boolean';
  }
  if (value.type === 'void') {
    return 'void';
  }
  if (value.type === 'identifier') {
    return value.name;
  }
  if (value.type === 'function') {
    return `(${value.parameters.map(processType).join(', ')}) => ${processType(value.return)}`;
  }
  if (value.type === 'link') {
    return value.id.substr(value.id.lastIndexOf(':') + 1);
  }
  if (value.type === 'application') {
    let name = value.base.name;
    if (!name) {
      name = value.base.id.substr(value.base.id.lastIndexOf(':') + 1);
    }
    return `${name}<${value.typeParameters.map(processType).join(', ')}>`;
  }
  if (value.type === 'typeParameter') {
    let typeParam = value.name;
    if (value.constraint) {
      typeParam = typeParam + ` extends ${processType(value.constraint)}`;
    }
    if (value.default) {
      typeParam = typeParam + ` = ${processType(value.default)}`;
    }
    return typeParam;
  }
  console.log('unknown type', value);
}

function rebuildInterfaces(json) {
  let exports = {};
  Object.keys(json.exports).forEach((key) => {
    if (key === 'links') {
      console.log('skipping links')
      return;
    }
    let item = json.exports[key];
    if (item?.type == null) {
      // todo what to do here??
      return;
    }
    if (item.props?.type === 'identifier') {
      // todo what to do here??
      return;
    }
    if (item.type === 'component') {
      let compInterface = {};
      if (item.props) {
        Object.entries(item.props.properties).sort((([keyA], [keyB]) => keyA > keyB ? 1 : -1)).forEach(([, prop]) => {
          if (prop.access === 'private') {
            return;
          }
          let name = prop.name;
          if (item.name === null) {
            name = key;
          }
          let optional = prop.optional;
          let defaultVal = prop.default;
          let value = processType(prop.value);
          // TODO: what to do with defaultVal and optional
          compInterface[name] = {optional, defaultVal, value};
        });
      }
      let name = item.name ?? key;
      if (item.typeParameters.length > 0) {
        name = name + `<${item.typeParameters.map(processType).sort().join(', ')}>`;
      }
      exports[name] = compInterface;
    } else if (item.type === 'function') {
      let funcInterface = {};
      Object.entries(item.parameters).sort((([keyA], [keyB]) => keyA > keyB ? 1 : -1)).forEach(([, param]) => {
        if (param.access === 'private') {
          return;
        }
        let name = param.name;
        let optional = param.optional;
        let defaultVal = param.default;
        let value = processType(param.value);
        // TODO: what to do with defaultVal and optional
        funcInterface[name] = {optional, defaultVal, value};
      });
      let returnVal = processType(item.return);
      let name = item.name ?? key;
      if (item.typeParameters.length > 0) {
        name = name + `<${item.typeParameters.map(processType).sort().join(', ')}>`;
      }
      exports[name] = {...funcInterface, returnVal};
    } else if (item.type === 'interface') {
      let funcInterface = {};
      Object.entries(item.properties).sort((([keyA], [keyB]) => keyA > keyB ? 1 : -1)).forEach(([, property]) => {
        if (property.access === 'private') {
          return;
        }
        let name = property.name;
        let optional = property.optional;
        let defaultVal = property.default;
        let value = processType(property.value);
        // TODO: what to do with defaultVal and optional
        funcInterface[name] = {optional, defaultVal, value};
      });
      let name = item.name ?? key;
      if (item.typeParameters.length > 0) {
        name = name + `<${item.typeParameters.map(processType).sort().join(', ')}>`;
      }
      exports[name] = funcInterface;
    } else if (item.type === 'link') {
      let links = json.links;
      if (links[item.id]) {
        let link = links[item.id];

        let name = link.name;
        let optional = link.optional;
        let defaultVal = link.default;
        let value = processType(link.value);
        let isType = true;
        exports[name] = {isType, optional, defaultVal, value};
      }
    } else {
      console.log('unknown top level export', item);
    }
  });
  return exports;
}


function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    let child = spawn(cmd, args, opts);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error('Child process failed'));
        return;
      }

      resolve();
    });
  });
}
