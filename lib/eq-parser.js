"use strict";

const utils = require("./utils");
const _ = require("lodash")
const constants = require("./constants")
const Moment = require('moment')
const MomentRange = require('moment-range')
require('moment-round')

const moment = MomentRange.extendMoment(Moment)


// Helper functions

/** Merger combines two deep objects, selecting the max of two shared keys. Skips the meta key */
function merger(o, s, k) {
    if (k == "meta") return
    if (k == "fights") return
    if (_.isNumber(o) && _.isNumber(s)) return Math.max(o, s)
    if (_.isObject(o) && _.isObject(s)) return _.mergeWith({}, o, s, merger)
    return
}

/** participantMerger combines two participant objects */
function participantMerger(o, s, k) {
    if (_.get(o, "ally") || _.get(s, "ally")) {
        let out = _.merge({}, o, s)
        out.ally = true
        return out
    }

    if (k == "attackers" || k == "healers") {
        // do a standard merge
        let out = _.mergeWith({}, o, s, merger)
        return out
    }
}

/** generateKey forms a unique string key to create a flat map based upon event criteria */
function generateKey(event) {
    let pieces = []
    if (event.timestamp) {
        let ts = moment(event.timestamp).ceil(15, 'seconds')
        pieces.push("ts-" + ts.toString())
    }
    if (event.target) pieces.push("t-" + event.target)
    if (event.subject) pieces.push("s-" + event.subject)
    if (event.attack) pieces.push("a-" + event.attack)
    if (event.spell) pieces.push("sp-" + event.spell)
    if (event.circumstance) pieces.push("ci-" + event.circumstance)
    if (event.amount) pieces.push("v-" + event.amount)
    if (event.totalheal) pieces.push("th-" + event.totalheal)
    if (event.actualheal) pieces.push("ah-" + event.actualheal)
    if (event.type) pieces.push("ty-" + event.type)
    return pieces.join("|")
}

function decodeKey(key) {
    let event = {}
    _.each(_.split(key, "|"), (part) => {
        if (_.startsWith(part, "t-")) event.target = part.substr(2)
        if (_.startsWith(part, "ts-")) event.timestamp = moment(part.substr(3)).unix()
        if (_.startsWith(part, "s-")) event.subject = part.substr(2)
        if (_.startsWith(part, "a-")) event.attack = part.substr(2)
        if (_.startsWith(part, "sp-")) event.spell = part.substr(3)
        if (_.startsWith(part, "ci-")) event.circumstance = part.substr(3)
        if (_.startsWith(part, "v-")) event.amount = parseInt(part.substr(2))
        if (_.startsWith(part, "th-")) event.totalheal = parseInt(part.substr(3))
        if (_.startsWith(part, "ah-")) event.actualheal = parseInt(part.substr(3))
        if (_.startsWith(part, "ty-")) event.type = part.substr(3)
    })
    return event
}


/** Combine fights aggregates fight data  
 *      This data is used to present aggregated information.
 *      Instead of costly merging functions, some accuracy loss is acceptable
 *      So, each fight has metrics calculated at 100 points throughout the fight, 
 *      These values are then averaged across the clients
 */
function combineFights(cFights) {
    let aggregated = []

    _.each(cFights, (fights) => {
        // for each fight, see if there is already a matching fight
        _.each(fights, (fight) => {
            let mergedFight = {}
            let ids = []
            let matches = _.filter(aggregated, (aFight, aID) => {
                if (_.toLower(fight.target) == _.toLower(aFight.target)) {
                    let fightRange = moment.range(moment(fight.firstAction), moment(fight.lastAction))
                    let aFightRange = moment.range(moment(aFight.firstAction), moment(aFight.lastAction))
                    if (fightRange.overlaps(aFightRange)) {
                        ids.push(aID)
                        return true
                    }
                }
                return false
            })
            if (matches.length > 0) {
                _.each(matches, (match, i) => {
                    aggregated[ids[i]] = mergeFights(match, fight)
                })
            } else {
                mergedFight = mergeFights(fight)
                aggregated.push(mergedFight)
            }
        })
    })
    return aggregated
}


function mergeFights(a, b) {
    // Go through the left side first
    let merged = {}
    if (_.get(a, "timeline")) {
        merged.firstAction = a.firstAction
        merged.lastAction = a.lastAction
        _.each(a.timeline, (count, aEvent) => {
            _.set(merged, ["timeline", aEvent], count)
        });
    }
    if (_.get(b, "timeline")) {
        if (b.firstAction < merged.firstAction) merged.firstAction = b.firstAction
        if (b.lastAction > merged.lastAction) merged.lastAction = b.lastAction
        // Now go through the right side, and replace with the greater value
        _.each(b.timeline, (count, bEvent) => {
            if (!_.get(merged, ["timeline", bEvent]) || _.get(merged, ["timeline", bEvent]) < count) _.set(merged, ["timeline", bEvent], count)
        })
    }
    merged.target = a.target
    return merged
}


function handleFights(client, data) {
    let foundFight = false
    // handle existing fights
    _.each(client.fights, (fight) => {
        // @ each event, close out all expired fights

        if (_.toLower(fight.target) != _.toLower(data.subject) && _.toLower(fight.target) != _.toLower(data.target) && fight.isActive && moment(data.timestamp).unix() > fight.lastAction + constants.idleFightThreshold) {
            fight.isActive = false
        }

        if (fight.isActive) {
            if (data.slain == "slain" && _.toLower(data.target) == _.toLower(fight.target)) {
                fight.slainTime = utils.adjustTimestamp(data.timestamp, client.clientTime)
                fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
                fight.isActive = false
                foundFight = true
            }
            // handle other events during the fight time here

            if (data.attack && _.toLower(data.target) == _.toLower(fight.target)) {
                // Hit on target
                foundFight = true
                fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
            } else if (data.attack && _.toLower(data.subject) == _.toLower(fight.target)) {
                // Hit by target
                foundFight = true
                fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
            } else if (data.totalheal && _.toLower(data.target) == _.toLower(fight.target)) {
                // Healing on mob
                foundFight = true
                fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
            } else if (data.totalheal && _.toLower(data.subject) != _.toLower(fight.target)) {
                // Healing by raid
                foundFight = true
                fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
            } else if (data.slain == "slain" && _.toLower(data.target) != _.toLower(fight.target)) {
                // Other slain
                foundFight = true
                fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
            } else if (data.type == "begin-casting") {
                // Spell cast during fight
                foundFight = true
                fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
            } else if (data.type == "spell-interrupted" || data.type == "spell-fizzles" || data.type == "spell-resisted") {
                foundFight = true
                fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
            }
            if (foundFight) {
                let key = generateKey(data)
                utils.deepIncrement(fight, ["timeline", key])
            }
        }

    })

    if (foundFight) return client

    // Handle new fights
    if ((data.target && _.get(constants, ["bosses", _.toLower(data.target)])) || (data.subject && _.get(constants, ["bosses", _.toLower(data.subject)]))) {
        let fight = {
            isActive: true,
            firstAction: utils.adjustTimestamp(data.timestamp, client.clientTime),
            lastAction: utils.adjustTimestamp(data.timestamp, client.clientTime),
            target: (_.get(constants, ["bosses", _.toLower(data.target)])) ? data.target : data.subject,
            raidLeader: client.raidLeader,
            timeline: {}
        }

        if (data.attack && _.get(constants, ["bosses", _.toLower(data.target)])) {
            // Hit on target
            foundFight = true
            fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
            if (data.amount) {
                fight.dmgToMob += data.amount
            }
        } else if (data.attack && _.get(constants, ["bosses", _.toLower(data.subject)])) {
            // Hit by target
            foundFight = true
            fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
            if (data.amount) {
                fight.dmgFromMob += data.amount
            }

            // If this is a dot from a recently killed monster, ignore it
            if (data.spell) {
                let prior = _.filter(client.fights, (f) => {
                    return (_.toLower(f.target) == _.toLower(data.subject) && (f.lastAction + constants.idleFightThreshold > utils.adjustTimestamp(data.timestamp, client.clientTime)) && !f.isActive)
                })

                if (prior) {
                    return client
                }

            }
        } else if (data.totalheal && _.get(constants, ["bosses", _.toLower(data.target)])) {
            // Healing on mob
            foundFight = true
            fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
            fight.healingOnMob += data.totalheal
        } else if (data.totalheal && !_.get(constants, ["bosses", _.toLower(data.target)])) {
            // Healing by raid
            foundFight = true
            fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
            fight.healingByRaid += data.totalheal
        } else if (data.slain == "slain" && (_.get(client, ["participants", data.target, "ally"]))) {
            // Other slain
            foundFight = true
            fight.lastAction = utils.adjustTimestamp(data.timestamp, client.clientTime)
        }

        if (foundFight) {
            let key = generateKey(data)
            utils.deepIncrement(fight, ["timeline", key])
        }

        if (!client.fights) client.fights = []
        client.fights.push(fight)
    }

    return client

}

function updateFightDetails(f, e, count) {
    // Done TO the mob
    if (_.toLower(e.target) == _.toLower(f.target)) {
        // this is an attack that dealt dmg
        if (e.amount && (e.attack || e.spell)) {
            // top level
            utils.deepIncrement(f, ["dmgToMob"], e.amount * count)
            if (e.attack != "spell") {
                utils.deepIncrement(f, ["attacks", e.attack, "hit"], count)
                utils.deepIncrement(f, ["attacks", e.attack, "attack"], count)
                utils.deepIncrement(f, ["attacks", e.attack, "dmgToMob"], count * e.amount)
            } else if (e.spell || e.attack == "spell") {
                if (e.type == "spell-dot-tick")
                    utils.deepIncrement(f, ["spells", e.spell, "tick"], count)
                else
                    utils.deepIncrement(f, ["spells", e.spell, "hit"], count)
                utils.deepIncrement(f, ["spells", e.spell, "dmgToMob"], count * e.amount)
            }

            // attacker details
            utils.deepIncrement(f, ["attackers", e.subject, "dmgToMob"], e.amount * count)
            if (e.attack != "spell") {
                utils.deepIncrement(f, ["attackers", e.subject, "attacks", e.attack, "hit"], count)
                utils.deepIncrement(f, ["attackers", e.subject, "attacks", e.attack, "attack"], count)
                utils.deepIncrement(f, ["attackers", e.subject, "attacks", e.attack, "dmgToMob"], count * e.amount)
            } else if (e.spell || e.attack == "spell") {
                if (e.type == "spell-dot-tick")
                    utils.deepIncrement(f, ["attackers", e.subject, "spells", e.spell, "tick"], count)
                else
                    utils.deepIncrement(f, ["attackers", e.subject, "spells", e.spell, "hit"], count)
                utils.deepIncrement(f, ["attackers", e.subject, "spells", e.spell, "dmgToMob"], count * e.amount)
            }

            // frame details
            utils.deepIncrement(f, ["frames", e.timestamp, "dmgToMob"], e.amount * count)
            utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "dmgToMob"], e.amount * count)
            _.set(f, ["frames", e.timestamp, "dmgToMobTotal"], _.get(f, ["dmgToMob"]))
            _.set(f, ["frames", e.timestamp, "attackers", e.subject, "dmgToMobTotal"], _.get(f, ["attackers", e.subject, "dmgToMob"]))
            if (e.attack != "spell") {
                utils.deepIncrement(f, ["frames", e.timestamp, "attacks", e.attack, "hit"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "attacks", e.attack, "attack"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "attacks", e.attack, "dmgToMob"], count * e.amount)
                _.set(f, ["frames", e.timestamp, "attacks", e.attack, "dmgToMobTotal"], _.get(f, ["attacks", e.attack, "dmgToMob"]))
                utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "attacks", e.attack, "hit"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "attacks", e.attack, "attack"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "attacks", e.attack, "dmgToMob"], count * e.amount)
                _.set(f, ["frames", e.timestamp, "attackers", e.subject, "attacks", e.attack, "dmgToMobTotal"], _.get(f, ["attackers", e.subject, "attacks", e.attack, "dmgToMob"]))
            } else if (e.spell || e.attack == "spell") {
                if (e.type == "spell-dot-tick")
                    utils.deepIncrement(f, ["frames", e.timestamp, "spells", e.spell, "tick"], count)
                else
                    utils.deepIncrement(f, ["frames", e.timestamp, "spells", e.spell, "hit"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "spells", e.spell, "dmgToMob"], count * e.amount)
                _.set(f, ["frames", e.timestamp, "spells", e.spell, "dmgToMobTotal"], _.get(f, ["spells", e.spell, "dmgToMob"]))
                if (e.type == "spell-dot-tick")
                    utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "spells", e.spell, "tick"], count)
                else
                    utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "spells", e.spell, "hit"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "spells", e.spell, "dmgToMob"], count * e.amount)
                _.set(f, ["frames", e.timestamp, "attackers", e.subject, "spells", e.spell, "dmgToMobTotal"], _.get(f, ["attackers", e.subject, "spells", e.spell, "dmgToMob"]))
            }
        }
        // Miss on the mob
        else if (e.attack || e.spell) {
            // top level
            if (e.attack != "spell") {
                utils.deepIncrement(f, ["attacks", e.attack, "miss"], count)
                utils.deepIncrement(f, ["attacks", e.attack, "attack"], count)
                if (e.circumstance != "miss") utils.deepIncrement(f, ["attacks", e.attack, e.circumstance])
            } else if (e.spell || e.attack == "spell") {
                utils.deepIncrement(f, ["spells", e.spell, "miss"], count || 1)
                utils.deepIncrement(f, ["spells", e.spell, e.circumstance])
            }

            // attacker details
            if (e.attack != "spell") {
                utils.deepIncrement(f, ["attackers", e.subject, "attacks", e.attack, "miss"], count)
                utils.deepIncrement(f, ["attackers", e.subject, "attacks", e.attack, "attack"], count)
                if (e.circumstance != "miss") utils.deepIncrement(f, ["attackers", e.subject, "attacks", e.attack, e.circumstance])
            } else if (e.spell || e.attack == "spell") {
                utils.deepIncrement(f, ["attackers", e.subject, "spells", e.spell, "miss"], count)
                utils.deepIncrement(f, ["attackers", e.subject, "spells", e.spell, e.circumstance])
            }

            // frame details
            if (e.attack != "spell") {
                utils.deepIncrement(f, ["frames", e.timestamp, "attacks", e.attack, "miss"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "attacks", e.attack, "attack"], count)
                if (e.circumstance != "miss") utils.deepIncrement(f, ["frames", e.timestamp, "attacks", e.attack, e.circumstance])
                utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "attacks", e.attack, "miss"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "attacks", e.attack, "attack"], count)
                if (e.circumstance != "miss") utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "attacks", e.attack, e.circumstance])
            } else if (e.spell || e.attack == "spell") {
                utils.deepIncrement(f, ["frames", e.timestamp, "spells", e.spell, "miss"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "spells", e.spell, e.circumstance])
                utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "spells", e.spell, "cast"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "spells", e.spell, "miss"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "spells", e.spell, e.circumstance])
            }
        }
        // Healing on the mob
        else if (e.totalheal || e.actualheal) {
            // top level
            utils.deepIncrement(f, ["healingOnMob"], e.actualheal * count)
            utils.deepIncrement(f, ["overHealingOnMob"], (e.totalheal - e.actualheal) * count)
            utils.deepIncrement(f, ["spells", e.spell, "healingOnMob"], e.actualheal * count)
            utils.deepIncrement(f, ["spells", e.spell, "overHealingOnMob"], (e.totalheal - e.actualheal) * count)

            // healer details
            utils.deepIncrement(f, ["healers", e.subject, "healingOnMob"], e.actualheal * count)
            utils.deepIncrement(f, ["healers", e.subject, "overHealingOnMob"], (e.totalheal - e.actualheal) * count)
            utils.deepIncrement(f, ["healers", e.subject, "spells", e.spell, "healingOnMob"], e.actualheal * count)
            utils.deepIncrement(f, ["healers", e.subject, "spells", e.spell, "overHealingOnMob"], (e.totalheal - e.actualheal) * count)

            // frame details
            utils.deepIncrement(f, ["frames", e.timestamp, "healingOnMob"], e.actualheal * count)
            utils.deepIncrement(f, ["frames", e.timestamp, "overHealingOnMob"], (e.totalheal - e.actualheal) * count)
            utils.deepIncrement(f, ["frames", e.timestamp, "spells", e.spell, "healingOnMob"], e.actualheal * count)
            utils.deepIncrement(f, ["frames", e.timestamp, "spells", e.spell, "overHealingOnMob"], (e.totalheal - e.actualheal) * count)
            utils.deepIncrement(f, ["frames", e.timestamp, "healers", e.subject, "healingOnMob"], e.actualheal * count)
            utils.deepIncrement(f, ["frames", e.timestamp, "healers", e.subject, "overHealingOnMob"], (e.totalheal - e.actualheal) * count)
            utils.deepIncrement(f, ["frames", e.timestamp, "healers", e.subject, "spells", e.spell, "healingOnMob"], e.actualheal * count)
            utils.deepIncrement(f, ["frames", e.timestamp, "healers", e.subject, "spells", e.spell, "overHealingOnMob"], (e.totalheal - e.actualheal) * count)
        }
    }
    // Done FROM the mob
    else if (_.toLower(e.subject) == _.toLower(f.target)) {
        // this is an attack that dealt dmg
        if (e.amount && (e.attack || e.spell)) {
            // top level
            utils.deepIncrement(f, ["dmgFromMob"], e.amount * count)
            if (e.attack != "spell") {
                utils.deepIncrement(f, ["enemy", "attacks", e.attack, "attack"], count)
                utils.deepIncrement(f, ["enemy", "attacks", e.attack, "hit"], count)
                utils.deepIncrement(f, ["enemy", "attacks", e.attack, "dmgFromMob"], count * e.amount)
            } else if (e.spell || e.attack == "spell") {
                if (e.type == "spell-dot-tick")
                    utils.deepIncrement(f, ["enemy", "spells", e.spell, "tick"], count)
                else
                    utils.deepIncrement(f, ["enemy", "spells", e.spell, "hit"], count)
                utils.deepIncrement(f, ["enemy", "spells", e.spell, "dmgFromMob"], count * e.amount)
            }

            // attacker details
            if (e.target != f.target) {
                utils.deepIncrement(f, ["enemy", "attackers", e.target, "dmgFromMob"], e.amount * count)
                if (e.attack != "spell") {
                    utils.deepIncrement(f, ["enemy", "attackers", e.target, "attacks", e.attack, "attack"], count)
                    utils.deepIncrement(f, ["enemy", "attackers", e.target, "attacks", e.attack, "hit"], count)
                    utils.deepIncrement(f, ["enemy", "attackers", e.target, "attacks", e.attack, "dmgFromMob"], count * e.amount)
                } else if (e.spell || e.attack == "spell") {
                    if (e.type == "spell-dot-tick")
                        utils.deepIncrement(f, ["enemy", "attackers", e.target, "spells", e.spell, "tick"], count)
                    else
                        utils.deepIncrement(f, ["enemy", "attackers", e.target, "spells", e.spell, "hit"], count)
                    utils.deepIncrement(f, ["enemy", "attackers", e.target, "spells", e.spell, "dmgFromMob"], count * e.amount)
                }

                // frame details
                utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "dmgFromMob"], e.amount * count)
                utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attackers", e.target, "dmgFromMob"], e.amount * count)
                _.set(f, ["frames", e.timestamp, "dmgFromMobTotal"], _.get(f, ["dmgFromMob"]))
                _.set(f, ["frames", e.timestamp, "attackers", e.target, "dmgFromMobTotal"], _.get(f, ["attackers", e.target, "dmgFromMob"]))
                if (e.attack != "spell") {
                    utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attacks", e.attack, "hit"], count)
                    utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attacks", e.attack, "dmgFromMob"], count * e.amount)
                    utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attackers", e.target, "attacks", e.attack, "hit"], count)
                    utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attackers", e.target, "attacks", e.attack, "dmgFromMob"], count * e.amount)
                } else if (e.spell || e.attack == "spell") {
                    if (e.type == "spell-dot-tick")
                        utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "spells", e.spell, "tick"], count)
                    else
                        utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "spells", e.spell, "hit"], count)
                    utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "spells", e.spell, "dmgFromMob"], count * e.amount)
                    if (e.type == "spell-dot-tick")
                        utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attackers", e.target, "spells", e.spell, "tick"], count)
                    else
                        utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attackers", e.target, "spells", e.spell, "hit"], count)
                    utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attackers", e.target, "spells", e.spell, "dmgFromMob"], count * e.amount)
                }
            }
        }
        // Miss by the mob
        else if (e.attack || e.spell) {
            // top level
            if (e.attack != "spell") {
                utils.deepIncrement(f, ["enemy", "attacks", e.attack, "miss"], count)
                utils.deepIncrement(f, ["enemy", "attacks", e.attack, "attack"], count)
                if (e.circumstance != "miss") utils.deepIncrement(f, ["enemy", "attacks", e.attack, e.circumstance])
            } else if (e.spell || e.attack == "spell") {
                if (e.type == "begin-casting")
                    utils.deepIncrement(f, ["enemy", "spells", e.spell, "cast"], count)
                else
                    utils.deepIncrement(f, ["enemy", "spells", e.spell, "miss"], count)
                utils.deepIncrement(f, ["enemy", "spells", e.spell, e.circumstance])
            }

            // frame details
            if (e.attack != "spell") {
                utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attacks", e.attack, "miss"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attacks", e.attack, "attack"], count)
                if (e.circumstance != "miss") utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attacks", e.attack, e.circumstance])
                utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attackers", e.subject, "attacks", e.attack, "miss"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attackers", e.subject, "attacks", e.attack, "attack"], count)
                if (e.circumstance != "miss") utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attackers", e.subject, "attacks", e.attack, e.circumstance])
            } else if (e.spell || e.attack == "spell") {
                if (e.type == "begin-casting")
                    utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "spells", e.spell, "cast"], count)
                else
                    utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "spells", e.spell, "miss"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "spells", e.spell, e.circumstance])
                utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attackers", e.subject, "spells", e.spell, "miss"], count)
                utils.deepIncrement(f, ["frames", e.timestamp, "enemy", "attackers", e.subject, "spells", e.spell, e.circumstance])
            }
        }
    }
    // Healing on the raid
    else if (e.totalheal || e.actualheal) {
        // top level
        utils.deepIncrement(f, ["healingOnOthers"], e.actualheal * count)
        utils.deepIncrement(f, ["overHealingOnOthers"], (e.totalheal - e.actualheal) * count)
        utils.deepIncrement(f, ["spells", e.spell, "healingOnOthers"], e.actualheal * count)
        utils.deepIncrement(f, ["spells", e.spell, "overHealingOnOthers"], (e.totalheal - e.actualheal) * count)

        // healer details
        utils.deepIncrement(f, ["healers", e.subject, "healingOnOthers"], e.actualheal * count)
        utils.deepIncrement(f, ["healers", e.subject, "overHealingOnOthers"], (e.totalheal - e.actualheal) * count)
        utils.deepIncrement(f, ["healers", e.subject, "spells", e.spell, "healingOnOthers"], e.actualheal * count)
        utils.deepIncrement(f, ["healers", e.subject, "spells", e.spell, "overHealingOnOthers"], (e.totalheal - e.actualheal) * count)

        // frame details
        utils.deepIncrement(f, ["frames", e.timestamp, "healingOnOthers"], e.actualheal * count)
        utils.deepIncrement(f, ["frames", e.timestamp, "overHealingOnOthers"], (e.totalheal - e.actualheal) * count)
        utils.deepIncrement(f, ["frames", e.timestamp, "spells", e.spell, "healingOnOthers"], e.actualheal * count)
        utils.deepIncrement(f, ["frames", e.timestamp, "spells", e.spell, "overHealingOnOthers"], (e.totalheal - e.actualheal) * count)
        utils.deepIncrement(f, ["frames", e.timestamp, "healers", e.subject, "healingOnOthers"], e.actualheal * count)
        utils.deepIncrement(f, ["frames", e.timestamp, "healers", e.subject, "overHealingOnOthers"], (e.totalheal - e.actualheal) * count)
        utils.deepIncrement(f, ["frames", e.timestamp, "healers", e.subject, "spells", e.spell, "healingOnOthers"], e.actualheal * count)
        utils.deepIncrement(f, ["frames", e.timestamp, "healers", e.subject, "spells", e.spell, "overHealingOnOthers"], (e.totalheal - e.actualheal) * count)
    }
    // Spell cast by raid
    else if (e.type == "begin-casting") {
        utils.deepIncrement(f, ["spells", e.spell, "cast"], count)
        utils.deepIncrement(f, ["attackers", e.subject, "spells", e.spell, "cast"], count)
        utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "spells", e.spell, "cast"], count)
    }
    // Spell failure by raid
    else if (e.type == "spell-fizzles" || e.type == "spell-resisted" || e.type == "spell-interrupted") {
        utils.deepIncrement(f, ["spells", e.spell, "miss"], count)
        utils.deepIncrement(f, ["spells", e.spell, e.circumstance], count)
        utils.deepIncrement(f, ["attackers", e.subject, "spells", e.spell, e.circumstance], count)
        utils.deepIncrement(f, ["attackers", e.subject, "spells", e.spell, "miss"], count)
        utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "spells", e.spell, e.circumstance], count)
        utils.deepIncrement(f, ["frames", e.timestamp, "attackers", e.subject, "spells", e.spell, "miss"], count)
    }
}

function checkForAlly(data, client) {
    let self = client.self

    // Anyone that has talked to you is an ally
    if (data.sender) _.set(client, ["participants", data.sender, "ally"], true)

    // Anyone that joins a raid, group, guild, etc is an ally
    if (data.joiner) _.set(client, ["participants", data.subject, "ally"], true)
    // You are your own ally
    if (data.subject == self) _.set(client, ["participants", data.subject, "ally"], true)

    // People healing you are your ally
    if (data.totalheal > 0 && data.target == self) _.set(client, ["participants", data.subject, "ally"], true)

    // People healing your allies are your ally
    if (data.totalheal > 0 && _.get(client, ["participants", data.target, "ally"])) _.set(client, ["participants", data.subject, "ally"], true)
    // add to an healers map, we will later use this to determine if the target is an ally, and then add all healers to the ally list 
    else if (data.totalheal > 0) _.set(client, ["participants", data.target, "healers", data.subject], true)

    // if this isn't a heal, then it is an attack (exclude damage shields in case of oddities)
    if (!data.totalheal && !data.damageshield) {
        // add to an attackers map, we will later use this to determine if the target is an enemy, and then add all attackers to the ally list 
        _.set(client, ["participants", data.target, "attackers", data.subject], true)
    }

    // People on your who list are your ally
    if (data.player) _.set(client, ["participants", data.player, "ally"], true)
}

function checkForPlayerClass(data, client) {
    if (data.playerClass) {
        _.set(client, ["participants", data.player, "class"], data.playerClass)
    }
}

function calculateMergedAllies(participants) {
    let keys = _.keys(participants)
    // run this two times, to account for newly found allies
    let ran = false
    while (!ran) {
        _.each(keys, (key) => {
            if (!participants[key].ally) {
                // Mostly attacked enemies
                if (_.filter(participants[key].attackers, (v, a) => (v && _.get(participants, [a, "ally"]))).length / _.keys(participants[key].attackers).length < .5) _.set(participants, [key, "ally"], true)
                // Healed allies
                if (_.filter(participants[key].healers, (v, a) => (v && _.get(participants, [a, "ally"]))).length > 0) _.set(participants, [key, "ally"], true)
            }
        })
        ran = true
    }
}

/** A note about trash mobs: 
 *  1) We don't care about individual mob names
 *  2) We don't care about individual fights
 *  3) This is mostly unimportant, but not so much that it shouldn't be displayed.
 *  4) TODO: Sort trash by zone
 */

function mergeTrashMobs(targets) {
    return targets
}

class EQParser {
    constructor(options) {
        // handle options here later
        options = options || {}
        this.idleFightThreshold = options.idleFightThreshold || 30000
        this.fights = {}
        this.participants = {}
        this.self = options.self
    }

    parse(data, client) {
        // set the owner
        this.self = client.self

        // data parsing is done later, on demand, instead an event is logged in the fight
        checkForAlly(data, client)
        checkForPlayerClass(data, client)
        client = handleFights(client, data)

        return client
    }


    combineData(clients) {
        let master = {
            participants: [],
            fights: []
        }
        let participants = []
        let fights = []
        for (var id in clients) {
            participants.push(_.cloneDeep(clients[id].participants))
            fights.push(clients[id].fights)
        }

        _.mergeWith(master.participants, ...participants, participantMerger)
        calculateMergedAllies(master.participants)
        master.fights = combineFights(fights)

        // calculate meta based on merged data
        return master
    }

    calculate(client) {
        let metrics = {
            participants: client.participants,
            fights: client.fights,
            calculated: []
        }
        _.each(client.fights, (fight) => {
            let f = {
                startTime: fight.firstAction,
                endTime: fight.lastAction,
                frames: {},
                dmgToMob: 0,
                dmgFromMob: 0,
                healingOnMob: 0,
                healingByRaid: 0,
                otherSlain: 0,
                target: fight.target,
                duration: fight.lastAction - fight.firstAction,
                id: fight.target + '|' + fight.firstAction
            }
            _.each(fight.timeline, (count, key) => {
                let event = decodeKey(key)
                // Now update the appropriate frame with this event info
                updateFightDetails(f, event, count)
            })
            metrics.calculated.push(f)
        })

        return metrics
    }
}

module.exports = EQParser;