"use strict";
const _ = require("lodash")

module.exports = {
    adjustTimestamp: function (timestamp, secOffset) {
        return (Date.parse(timestamp) + secOffset) / 1000
    },
    getGroupedTimestamp: function (timestamp) {
        return Math.floor(timestamp / (60 * 1000)) * 60 * 1000
    },
    makeKeyFromEvent: function (event) {
        let key = ""
        key += Date.parse(event.timestamp).toString()
        if (event.subject) key += "-" + event.subject
        if (event.attack) key += "-" + event.attack
        if (event.target) key += "-" + event.target
        if (event.amount) key += "-" + event.amount
        if (event.circumstance) key += "-" + event.circumstance
        return key
    },
    deepIncrement: function (obj, path, amount) {
        amount = amount || 1
        return _.set(obj, path, _.get(obj, path, 0) + amount)
    },
    geti: function (value, prop, defaultValue) {
        if (_.isPlainObject(value)) {
            if (_.isString(prop) && prop !== '') {
                return geti(value, prop.split('.'));
            } else if (_.isArray(prop) && prop.length) {
                const key = _.toLower(prop.shift()),
                    val = Object.keys(value).reduce(function (a, k) {
                        if (a !== undefined) {
                            return a;
                        }
                        if (_.toLower(k) === key) {
                            return value[k];
                        }
                    }, undefined);
                if (prop.length) {
                    let v = this.geti(val, prop);
                    return v === undefined ? defaultValue : v;
                }
                return val === undefined ? defaultValue : val;
            }
        }
        throw new Error(`iget value argument must be an object`);
    }
}