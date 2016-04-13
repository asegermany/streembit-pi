﻿/*

This file is part of Streembit application. 
Streembit is an open source project to create a real time communication system for humans and machines. 

Streembit is a free software: you can redistribute it and/or modify it under the terms of the GNU General Public License 
as published by the Free Software Foundation, either version 3.0 of the License, or (at your option) any later version.

Streembit is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty 
of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with Streembit software.  
If not, see http://www.gnu.org/licenses/.
 
-------------------------------------------------------------------------------------------------------------------------
Author: Tibor Zsolt Pardi 
Copyright (C) 2016 The Streembit software development team
-------------------------------------------------------------------------------------------------------------------------

*/


'use strict';

var streembit = streembit || {};

var util = require('util');
var assert = require('assert');
var wotmsg = require("streembitlib/message/wotmsg");
var uuid = require("uuid");
var Map = require("collections/map");
var secrand = require('secure-random');
var nodecrypto = require(global.cryptolib);
var streembitkad = require('streembitlib/streembitkad/kaddht');
streembit.config = require("./config.json");
streembit.DEFS = require("./appdefs.js");
streembit.account = require("./account");
streembit.Message = require("./message");


streembit.PeerTransport = (function (obj, logger, events, config ) {
    
    var DEFAULT_STREEMBIT_PORT = 32320;
    
    obj.node = 0;
    obj.is_publickey_uplodaed = false;
    obj.is_connected = false;
    
    function onPeerMessage(message, info) {
        try {
            if (!message) {
                return streembit.notify.error("Invalid message at onPeerMessage");
            }
            if (!message.type || message.type != "PEERMSG") {
                return streembit.notify.error("Invalid message type at onPeerMessage");
            }
            if (!message.data) {
                return streembit.notify.error("Invalid message data at onPeerMessage");
            }
            
            //  raise an application event that a peer sent a message
            events.emit(events.APPEVENT, events.TYPES.ONPEERMSG, message.data, info);
            
        }
        catch (err) {
            logger.error("onPeerMessage error %j", err);
        }
    }
    
    function msg_stored(node_id, item) {
        if (!item || !item.key || !item.hash)
            return;
        
        //logger.debug("peertransport msg_stored, item.key: " + item.key);
        
        var key = item.key;
        if (item && key && item.value) {
            if (key.indexOf("/") == -1) {
                //  this is a contact update
                //events.emit(events.CONTACT_ONLINE, item.key, item);
            }
            else {
                var msgkey = streembit.User.name + "/message/";
                if (key.indexOf(msgkey) > -1 && item.recipient == streembit.User.name) {
                    //logger.debug("off-line message item: %j", item);
                    var items = [item];
                    events.emit(events.APPEVENT, events.TYPES.ONACCOUNTMSG, items);
                }
            }
        }
    }
    
    function onNodeError(err, contact, data) {
        //logger.error("onNodeError: %j", err);     
        events.emit(events.APPEVENT, events.TYPES.ONPEERERROR, { error: err, contact: contact, data: data });
    }
    
    function onNetworkError(errcode, msg) {
        logger.error("Network handler error code: " + errcode + ", error message: " + (msg || "NA"));
    }
    
    function get_account_id() {
        var id = uuid.v4().toString();
        var accountId = id.replace(/-/g, '');
        return accountId;
    }
    
    obj.is_node_connected = function () {
        return obj.is_connected;
    }
    
    obj.init = function (bootdata, db, resultfn) {
        if (obj.node && obj.is_connected == true) {
            obj.node.close();
            obj.is_connected = false;
        }
        
        if (!bootdata || !bootdata.seeds || !bootdata.seeds.length) {
            return resultfn("Invalid seeds");
        }
        
        var is_private_network = bootdata.isprivate_network;
        var private_network_accounts = bootdata.private_accounts;
        
        var accountId;
        if (config.private_network == false) {
            if (is_private_network && private_network_accounts && private_network_accounts.length) {
                return resultfn("Public network is requested. The seed is a private network.");
            }
        }
        else {
            if (!is_private_network || !private_network_accounts || !private_network_accounts.length) {
                return resultfn("Invalid private network information boot data");
            }
        }
        
        accountId = config.node.account || get_account_id();
        logger.debug("Current peer account is " + accountId);
        
        var seedlist = [];
        
        for (var i = 0; i < bootdata.seeds.length; i++) {
            if (!bootdata.seeds[i].port) {
                bootdata.seeds[i].port = DEFAULT_STREEMBIT_PORT;
            }
            
            if (config.private_network == true) {
                if (!bootdata.seeds[i].account) {
                    return resultfn("Invalid seed configuration data. The seed must have an account in a private network");
                }
            }
            else {
                if (!bootdata.seeds[i].account) {
                    var str = "" + bootdata.seeds[i].address + ":" + bootdata.seeds[i].port;
                    var buffer = new Buffer(str);
                    var acc = nodecrypto.createHash('sha1').update(buffer).digest().toString('hex');
                    bootdata.seeds[i].account = acc;
                }
            }
            
            // remove our own account id in case if it is in the list
            if (bootdata.seeds[i].account != accountId) {
                seedlist.push(bootdata.seeds[i]);
                logger.debug("seed: %j", bootdata.seeds[i]);
            }
        }
        
        var options = {
            onnodeerror: onNodeError,
            onnetworkerror: onNetworkError,
            log: logger,
            port: config.node.port,
            account: accountId,
            seeds: seedlist, 
            peermsgHandler: onPeerMessage,
            storage: db,
            is_private_network: is_private_network,
            private_network_accounts: private_network_accounts,
            is_gui_node: false,
            contact_exist_lookupfn: null
        };
        
        try {
            var peernode = streembitkad(options);
            peernode.create(function (err) {
                if (err) {
                    return resultfn(err);
                }
                
                logger.debug("peernode.create complete");
                
                obj.is_connected = true;
                obj.node = peernode;
                
                var address = obj.node.Address;
                var port = obj.node.Port;
                if (!address || !port) {
                    return resultfn("Invalid peer address and port");
                }
                
                streembit.account.address = address;
                streembit.account.port = port;
                
                obj.node.is_seedcontact_exists(function (result) {
                    if (result) {
                        logger.debug("seed contact exists in buckets");
                        resultfn();
                    }
                    else {
                        resultfn("communication with seeds failed");
                    }
                });
            });
            
            // handle msgstored event
            peernode.on('msgstored', msg_stored);

            //
            //
        }
        catch (e) {
            resultfn(e);
        }
    }
    
    obj.validate_connection = function (callback) {
        try {
            obj.node.validate_connection(function (err) {
                if (err) {
                    //  it was an error
                    //  close the node connection 
                    if (obj.node && obj.is_connected == true) {
                        obj.node.close();
                        obj.is_connected = false;
                        obj.node = null;
                    }
                }
                callback(err);
            });
        }
        catch (e) {
            callback(e);
        }
    }
    
    obj.put = function (key, value, callback) {
        //  For this public key upload message the key is the device name
        //  false == don't store locally
        obj.node.put(key, value, false, function (err, results) {
            if (callback) {
                callback(err, results);
            }
        });
    }
    
    obj.get = function (key, callback) {
        if (!callback || (typeof callback != "function"))
            throw new Error("invalid callback at node get");
        
        //  For this public key upload message the key is the device name
        obj.node.get(key, function (err, msg) {
            callback(err, msg);
        });
    }
    
    obj.find = function (key, callback) {
        if (!callback || (typeof callback != "function"))
            throw new Error("invalid callback at node find");
        
        //  For this public key upload message the key is the device name
        obj.node.find(key, function (err, msg) {
            callback(err, msg);
        });
    }
    
    obj.get_node = function (account, callback) {
        if (!callback || (typeof callback != "function"))
            throw new Error("invalid callback at find_node");
        
        //  For this public key upload message the key is the device name
        obj.node.getNode(account, function (err, msg) {
            callback(err, msg);
        });
    }
    
    obj.peer_send = function (contact, data) {
        try {
            if (!data) {
                throw new Error("peer_send invalid data parameter");
            }
            if (!contact) {
                throw new Error("peer_send invalid contact parameter");
            }
            
            var message = streembit.Message.create_peermsg(data);
            var options = { address: contact.address, port: contact.port };
            obj.node.peer_send(options, message);
        }
        catch (err) {
            logger.error("peer_send error:  %j", err);
        }
    }
    
    obj.get_account_messages = function (account, msgkey, callback) {
        try {
            if (!account) {
                throw new Error("get_account_messages invalid account parameter");
            }
            
            obj.node.get_account_messages(account, msgkey, callback);
        }
        catch (err) {
            logger.error("get_account_messages error:  %j", err);
        }
    }
    
    obj.delete_item = function (key, request) {
        obj.node.delete_item(key, request);
    }
    
    return obj;

}(streembit.PeerTransport || {}, global.applogger, global.appevents, streembit.config, streembit.MainDB));


streembit.TransportFactory = (function (module, logger, events, config) {
    
    Object.defineProperty(module, "transport", {
        get: function () {
            if (!config) {
                throw new Error("transport get error: config is empty");
            }
            if (!config.transport) {
                throw new Error("transport configuration is missing");
            }
            
            var transport;
            switch (config.transport) {
                case streembit.DEFS.TRANSPORT_TCP:
                    transport = streembit.PeerTransport;
                    break;
                case streembit.DEFS.TRANSPORT_WS:
                    transport = streembit.WebSocketTransport;
                    break;
                default:
                    throw new Error("Not implemented transport type " + config.transport);
            }
            
            return transport;
        },
    });
    
    module.get_contact_transport = function (contact) {
        if (!config) {
            throw new Error("transport get error: config is empty");
        }
        
        if (!config.transport) {
            throw new Error("transport configuration is missing");
        }
        
        if (!contact || !contact.protocol) {
            throw new Error("get_contact_transport error: contact.transport value is empty");
        }
        
        if (config.transport == streembit.DEFS.TRANSPORT_WS) {
            //  whatever transport the contact uses this account can communicate only via WS
            transport = streembit.WebSocketTransport;
        }
        else {
            var transport;
            switch (contact.protocol) {
                case streembit.DEFS.TRANSPORT_TCP:
                    transport = streembit.PeerTransport;
                    break;
                case streembit.DEFS.TRANSPORT_WS:
                    transport = streembit.WebSocketTransport;
                    break;
                default:
                    throw new Error("Not implemented transport type " + config.transport);
            }
        }
        
        return transport;
    }
    
    return module;

}(streembit.TransportFactory || {}, global.applogger, global.appevents, streembit.config));


streembit.Node = (function (module, logger, events, config) {
    
    module.init = function (seeds, db, callback) {
        var transport = streembit.TransportFactory.transport;
        transport.init(seeds, db, callback);
    }
    
    module.put = function (key, value, callback) {
        var transport = streembit.TransportFactory.transport;
        transport.put(key, value, callback);
    }
    
    module.get = function (key, callback) {
        var transport = streembit.TransportFactory.transport;
        transport.get(key, callback);
    }
    
    module.find = function (key, callback) {
        var transport = streembit.TransportFactory.transport;
        transport.find(key, callback);
    }
    
    module.find_account = function (account) {
        return new Promise(function (resolve, reject) {
            try {
                var transport = streembit.TransportFactory.transport;
                transport.get_node(account, function (err, contacts) {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(contacts);
                    }
                });
            }
            catch (err) {
                reject(err);
            }
        });
    }
    
    module.peer_send = function (contact, data) {
        // select a transport based on the contact's protocol
        var transport = streembit.TransportFactory.get_contact_transport(contact);
        transport.peer_send(contact, data);
    }
    
    module.get_account_messages = function (account, msgkey, callback) {
        var transport = streembit.TransportFactory.transport;
        transport.get_account_messages(account, msgkey, callback);
    }
    
    module.delete_item = function (key, request) {
        var transport = streembit.TransportFactory.transport;
        transport.delete_item(key, request);
    }
    
    module.validate_connection = function (callback) {
        var transport = streembit.TransportFactory.transport;
        transport.validate_connection(callback);
    }
    
    module.is_node_connected = function () {
        var transport = streembit.TransportFactory.transport;
        return transport.is_node_connected();
    }
    
    return module;

}(streembit.Node || {}, global.applogger, global.appevents, streembit.config));


streembit.PeerNet = (function (module, logger, events, config) {
    
    var msgmap = new Map();
    var list_of_sessionkeys = {};
    var list_of_waithandlers = {};
    
    module.find_contact = function (account, callback) {
        streembit.Node.find(account, function (err, msg) {
            try {
                if (err) {
                    return callback(err);
                }
                
                // parse the message
                var payload = wotmsg.getpayload(msg);
                if (!payload || !payload.data || !payload.data.type || payload.data.type != wotmsg.MSGTYPE.PUBPK 
                            || payload.data[wotmsg.MSGFIELD.PUBKEY] == null || payload.data[wotmsg.MSGFIELD.ECDHPK] == null) {
                    return callback("get_contact error: invalid contact payload");
                }
                
                var decoded = wotmsg.decode(msg, payload.data[wotmsg.MSGFIELD.PUBKEY]);
                if (!decoded || !decoded.data[wotmsg.MSGFIELD.PUBKEY]) {
                    return callback("get_contact error: invalid decoded contact payload");
                }
                
                var pkey = decoded.data[wotmsg.MSGFIELD.PUBKEY];
                var ecdhpk = decoded.data[wotmsg.MSGFIELD.ECDHPK];
                var address = decoded.data[wotmsg.MSGFIELD.HOST];
                var port = decoded.data[wotmsg.MSGFIELD.PORT];
                var utype = decoded.data[wotmsg.MSGFIELD.UTYPE];
                var protocol = wotmsg.MSGFIELD.PROTOCOL ? decoded.data[wotmsg.MSGFIELD.PROTOCOL] : streembit.DEFS.TRANSPORT_TCP;
                var contact = {
                    public_key: pkey, 
                    ecdh_public: ecdhpk, 
                    address: address, 
                    port: port, 
                    name: account, 
                    user_type: utype, 
                    protocol: protocol
                };
                
                callback(null, contact);
            }
            catch (e) {
                callback("get_contact error: " + e.message);
            }
        });
    }
    
    module.onPeerError = function (payload) {
        try {
            var err = payload.error, contact = payload.contact, data = payload.data;
            // get the jti field from the data
            var ishandled = false;
            if (data) {
                var buffer = new Buffer(data).toString();
                var obj = JSON.parse(buffer);
                if (obj.data) {
                    var msg = wotmsg.getpayload(obj.data);
                    if (msg && msg.jti) {
                        var handler = list_of_waithandlers[msg.jti];
                        if (handler && handler.waitfunc && handler.rejectfunc && handler.resolvefunc) {
                            try {
                                streembit.notify.hideprogress();
                                clearTimeout(handler.waitfunc);
                                return handler.rejectfunc(err);
                            }
                            catch (e) { }
                        }
                    }
                }
            }
            
            if (!ishandled) {
                //TODO don't show all errors
                streembit.notify.error("onPeerError error %j", err);
            }
        }
        catch (e) {
            logger.error("onPeerError error %j", e);
        }
    }
    
    function closeWaithandler(jti, result) {
        //console.log("closeWaithandler jti: " + jti);
        var handler = list_of_waithandlers[jti];
        if (handler) {
            try {
                streembit.notify.hideprogress();
            }
            catch (e) { }
            
            try {
                if (handler.waitfunc) {
                    clearTimeout(handler.waitfunc);
                }
            }
            catch (e) { }
            
            try {
                if (handler.resolvefunc) {
                    //console.log("closeWaithandler call resolvefunc jti: " + jti + " result: " + result);
                    handler.resolvefunc(result);
                }
            }
            catch (e) { }
            
            try {
                delete list_of_waithandlers[jti];
            }
            catch (e) { }
        }
        else {
            //console.log("closeWaithandler jti: " + jti + " NO HANDLER");
        }
    }
    
    function handleAcceptKey(sender, payload, msgtext) {
        try {
            logger.debug("Accept Key message received");
            // the msgtext is encrypted with the session symmetric key
            var session = list_of_sessionkeys[sender];
            if (!session) {
                throw new Error("Accept key unable to complete, session does not exist for " + sender);
            }
            
            var symmetric_key = session.symmetric_key;
            var plaintext = wotmsg.decrypt(symmetric_key, msgtext);
            var data = JSON.parse(plaintext);
            //  must have the request_jti field
            var jti = data[wotmsg.MSGFIELD.REQJTI]
            
            logger.debug("key for list of session accepted by " + sender);
            list_of_sessionkeys[sender].accepted = true;
            
            // find the wait handler, remove it and return the promise
            closeWaithandler(jti);
        }
        catch (e) {
            streembit.notify.error("handleAcceptKey error %j", e);
        }
    }
    
    function handleKeyExchange(sender, public_key, payload, msgtext) {
        try {
            logger.debug("Peer exchange key request received");
            
            var message = JSON.parse(msgtext);
            
            if (message.public_key != public_key) {
                throw new Error("invalid public key for contact " + sender);
            }
            
            // create a session by performing a symmetric key exchange
            var data = message.data;
            // decrypt the message to get the symmetric key
            var ecdh_public = message.ecdh_public_key;
            var plaintext = wotmsg.ecdh_decrypt(streembit.User.ecdh_key, ecdh_public, data);
            var plain_data = JSON.parse(plaintext);
            if (!plain_data)
                throw new Error("invalid message data for key exchange contact " + sender);
            
            var session_symmkey = plain_data.symmetric_key;
            if (!session_symmkey) {
                throw new Error("invalid session symmetric key for contact " + sender);
            }
            
            // send key accepted message
            var data = {};
            data[wotmsg.MSGFIELD.REQJTI] = payload.jti;
            
            var contact = streembit.Contacts.get_contact(sender);
            var jti = streembit.Message.create_id();
            var encoded_msgbuffer = wotmsg.create_symm_msg(wotmsg.PEERMSG.ACCK, jti, streembit.User.private_key, session_symmkey, data, streembit.User.name, sender);
            streembit.Node.peer_send(contact, encoded_msgbuffer);
            
            logger.debug("received symm key %s from contact %s", session_symmkey, sender);
            
            list_of_sessionkeys[sender] = {
                symmetric_key: session_symmkey,
                contact_ecdh_public: ecdh_public,
                contact_public_key: message.public_key,
                timestamp: Date.now(),
                accepted: true
            };
        }
        catch (e) {
            streembit.notify.error("handleKeyExchange error %j", e);
        }
    }
    
    function handlePing(sender, payload, msgtext) {
        try {
            logger.debug("Ping request received");
            
            var message = JSON.parse(msgtext);
            var timestamp = message[wotmsg.MSGFIELD.TIMES];
            var ecdh_public = message[wotmsg.MSGFIELD.ECDHPK];
            var address = message[wotmsg.MSGFIELD.HOST];
            var port = message[wotmsg.MSGFIELD.PORT];
            var protocol = message[wotmsg.MSGFIELD.PROTOCOL];
            logger.debug("Ping from: " + sender + ", address: " + address + ", port: " + port + ", protocol: " + protocol + ", ecdh_public: " + ecdh_public);
            
            if (!list_of_sessionkeys[sender]) {
                list_of_sessionkeys[sender] = {};
            }
            list_of_sessionkeys[sender].contact_ecdh_public = ecdh_public;
            logger.debug("handlePing ecdh_public: " + ecdh_public + " for " + sender);
            
            // send Ping reply message
            var data = {};
            data[wotmsg.MSGFIELD.REQJTI] = payload.jti;
            data[wotmsg.MSGFIELD.ECDHPK] = streembit.User.ecdh_public_key;
            
            var contact = streembit.Contacts.get_contact(sender);
            if (!contact) {
                throw new Error("Ping error: contact not exists");
            }
            
            contact.address = address;
            contact.port = port;
            contact.protocol = protocol;
            // update the contact with the latest address, port adn protocol data
            streembit.Contacts.update_contact_database(contact, function () {
                var jti = streembit.Message.create_id();
                var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.PREP, jti, streembit.User.private_key, data, streembit.User.name, sender);
                streembit.Node.peer_send(contact, encoded_msgbuffer);
                
                // update the contact online indicator
                streembit.Contacts.on_online(sender);
            });
            
        }
        catch (e) {
            streembit.notify.error("handlePing error %j", e);
        }
    }
    
    function handlePingReply(sender, payload, msgtext) {
        try {
            logger.debug("Ping reply (PREP) message received");
            
            var data = JSON.parse(msgtext);
            //  must have the request_jti field
            var jti = data[wotmsg.MSGFIELD.REQJTI];
            var ecdh_public = data[wotmsg.MSGFIELD.ECDHPK];
            
            if (!list_of_sessionkeys[sender]) {
                list_of_sessionkeys[sender] = {};
            }
            list_of_sessionkeys[sender].contact_ecdh_public = ecdh_public;
            logger.debug("handlePingReply ecdh_public: " + ecdh_public + " for " + sender);
            
            // find the wait handler, remove it and return the promise
            closeWaithandler(jti);
            
            // update the contact online indicator
            streembit.Contacts.on_online(sender);
        }
        catch (e) {
            streembit.notify.error("handlePingReply error %j", e);
        }
    }
    
    //
    function handleHangupCall(sender, payload, msgtext) {
        try {
            logger.debug("Hangup call (HCAL) message received");
            
            var session = list_of_sessionkeys[sender];
            if (!session) {
                throw new Error("handleHangupCall error, session does not exist for " + sender);
            }
            
            events.emit(events.TYPES.ONAPPNAVIGATE, streembit.DEFS.CMD_HANGUP_CALL, sender);

        }
        catch (e) {
            streembit.notify.error("handleCallReply error %j", e);
        }
    }
    
    function handleShareScreenOffer(sender, payload, msgtext) {
        try {
            logger.debug("Share screen offer received");
            
            var session = list_of_sessionkeys[sender];
            if (!session) {
                throw new Error("handleCall error, session does not exist for " + sender);
            }
            
            streembit.UI.accept_sharescreen(sender, function (result) {
                var data = {};
                data[wotmsg.MSGFIELD.REQJTI] = payload.jti;
                data[wotmsg.MSGFIELD.RESULT] = result ? true : false;
                
                var contact = streembit.Contacts.get_contact(sender);
                var jti = streembit.Message.create_id();
                var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.RSSC, jti, streembit.User.private_key, data, streembit.User.name, sender);
                streembit.Node.peer_send(contact, encoded_msgbuffer);
                
                // if the call was accepted on the UI then navigate to the share screen view and wait for the WebRTC session
                if (result) {
                    var uioptions = {
                        contact: contact,
                        iscaller: false // this is the recepient of the call -> iscaller = false 
                    };
                    events.emit(events.TYPES.ONAPPNAVIGATE, streembit.DEFS.CMD_RECIPIENT_SHARESCREEN, null, uioptions);
                }
            });
        }
        catch (e) {
            streembit.notify.error("handleCall error %j", e);
        }
    }
    
    function handleShareScreenReply(sender, payload, msgtext) {
        try {
            logger.debug("Share screen reply (RSSC) message received");
            
            var session = list_of_sessionkeys[sender];
            if (!session) {
                throw new Error("handleCallReply error, session does not exist for " + sender);
            }
            
            var data = JSON.parse(msgtext);
            //  must have the request_jti field
            var jti = data[wotmsg.MSGFIELD.REQJTI];
            var result = data[wotmsg.MSGFIELD.RESULT];
            
            //console.log("handleShareScreenReply jti:" + jti);
            
            // find the wait handler, remove it and return the promise
            closeWaithandler(jti, result);

        }
        catch (e) {
            streembit.notify.error("handleCallReply error %j", e);
        }
    }
    
    function handleCall(sender, payload, msgtext) {
        try {
            logger.debug("Call request received");
            
            var session = list_of_sessionkeys[sender];
            if (!session) {
                throw new Error("handleCall error, session does not exist for " + sender);
            }
            
            var message = JSON.parse(msgtext);
            var calltype = message[wotmsg.MSGFIELD.CALLT];
            if (!calltype) {
                throw new Error("invalid call type");
            }
            logger.debug("call type: " + calltype);
            
            streembit.UI.accept_call(sender, calltype, function (result) {
                var data = {};
                data[wotmsg.MSGFIELD.REQJTI] = payload.jti;
                data[wotmsg.MSGFIELD.CALLT] = calltype;
                data[wotmsg.MSGFIELD.RESULT] = result ? true : false;
                
                var contact = streembit.Contacts.get_contact(sender);
                var jti = streembit.Message.create_id();
                var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.CREP, jti, streembit.User.private_key, data, streembit.User.name, sender);
                streembit.Node.peer_send(contact, encoded_msgbuffer);
                
                // if the call was accepted on the UI then navigate to the video call view and wait for the WebRTC session
                if (result) {
                    var uioptions = {
                        contact: contact,
                        calltype: calltype,
                        iscaller: false // this is the recepient of the call -> iscaller = false 
                    };
                    events.emit(events.TYPES.ONAPPNAVIGATE, streembit.DEFS.CMD_CONTACT_CALL, null, uioptions);
                }
            });
        }
        catch (e) {
            streembit.notify.error("handleCall error %j", e);
        }
    }
    
    function handleCallReply(sender, payload, msgtext) {
        try {
            logger.debug("Call reply (CREP) message received");
            
            var session = list_of_sessionkeys[sender];
            if (!session) {
                throw new Error("handleCallReply error, session does not exist for " + sender);
            }
            
            var data = JSON.parse(msgtext);
            //  must have the request_jti field
            var jti = data[wotmsg.MSGFIELD.REQJTI];
            var calltype = data[wotmsg.MSGFIELD.CALLT];
            var result = data[wotmsg.MSGFIELD.RESULT];
            
            // find the wait handler, remove it and return the promise
            closeWaithandler(jti, result);

        }
        catch (e) {
            streembit.notify.error("handleCallReply error %j", e);
        }
    }
    
    function handleFileInit(sender, payload, data) {
        try {
            logger.debug("File init request received");
            
            var session = list_of_sessionkeys[sender];
            if (!session) {
                throw new Error("handleFileInit error, session does not exist for " + sender);
            }
            
            var obj = JSON.parse(data);
            if (!obj || !obj.file_name || !obj.file_size)
                throw new Error("handleFileInit error, invalid file data from " + sender);
            
            streembit.UI.accept_file(sender, obj.file_name, obj.file_size, function (result) {
                var data = {};
                data[wotmsg.MSGFIELD.REQJTI] = payload.jti;
                data[wotmsg.MSGFIELD.RESULT] = result ? true : false;
                
                var contact = streembit.Contacts.get_contact(sender);
                var jti = streembit.Message.create_id();
                var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.CREP, jti, streembit.User.private_key, data, streembit.User.name, sender);
                streembit.Node.peer_send(contact, encoded_msgbuffer);
                
                if (result) {
                    events.emit(events.TYPES.ONAPPNAVIGATE, streembit.DEFS.CMD_FILE_INIT, sender, obj);
                }
            });

        }
        catch (e) {
            streembit.notify.error("handleFileInit error %j", e);
        }
    }
    
    function handleFileReply(sender, payload, msgtext) {
        try {
            logger.debug("File reply (FREP) message received");
            
            var session = list_of_sessionkeys[sender];
            if (!session) {
                throw new Error("handleCallReply error, session does not exist for " + sender);
            }
            
            var data = JSON.parse(msgtext);
            //  must have the request_jti field
            var jti = data[wotmsg.MSGFIELD.REQJTI];
            var result = data[wotmsg.MSGFIELD.RESULT];
            
            // find the wait handler, remove it and return the promise
            closeWaithandler(jti, result);

        }
        catch (e) {
            streembit.notify.error("handleCallReply error %j", e);
        }
    }
    
    function handleAddContactRequest(sender, payload, msgtext) {
        try {
            logger.debug("Add contact request message received");
            
            var data = JSON.parse(msgtext);
            var contact = {
                name: sender,
                protocol: data[wotmsg.MSGFIELD.PROTOCOL],
                address: data[wotmsg.MSGFIELD.HOST],
                port: data[wotmsg.MSGFIELD.PORT],
                public_key: data[wotmsg.MSGFIELD.PUBKEY],
                user_type: data[wotmsg.MSGFIELD.UTYPE]
            };
            
            streembit.Contacts.on_receive_addcontact(contact);

            // close, don't reply here
        }
        catch (e) {
            streembit.notify.error("handleAddContactRequest error %j", e);
        }
    }
    
    /*
     * The contact replied with an accept for the add contact request
     */
    function handleAddContactAcceptReply(sender, payload, msgtext) {
        try {
            logger.debug("Add contact request message received");
            
            var data = JSON.parse(msgtext);
            var account = data.sender;
            if (sender != account) {
                throw new Error("invalid account, the account and sender do not match");
            }
            
            streembit.Contacts.handle_addcontact_accepted(account);

            // close, don't reply here
        }
        catch (e) {
            streembit.notify.error("handleAddContactRequest error %j", e);
        }
    }
    
    /*
     * The contact replied with a deny (DACR) for the add contact request
     */
    function handleAddContactDenyReply(sender, payload, msgtext) {
        try {
            logger.debug("Add contact request message received");
            
            var data = JSON.parse(msgtext);
            var account = data.sender;
            if (sender != account) {
                throw new Error("invalid account, the account and sender do not match");
            }
            
            streembit.Contacts.handle_addcontact_denied(account);

            // close, don't reply here
        }
        catch (e) {
            streembit.notify.error("handleAddContactDenyReply error %j", e);
        }
    }
    
    function handleSymmMessage(sender, payload, msgtext) {
        try {
            //logger.debug("handleSymmMessage message received");
            
            // the msgtext is encrypted with the session symmetric key
            var session = list_of_sessionkeys[sender];
            if (!session) {
                throw new Error("handleSymmMessage error, session does not exist for " + sender);
            }
            
            var symmetric_key = session.symmetric_key;
            var plaintext = wotmsg.decrypt(symmetric_key, msgtext);
            var data = JSON.parse(plaintext);
            
            //  process the data 
            if (!data || !data.cmd)
                return;
            
            switch (data.cmd) {
                case streembit.DEFS.PEERMSG_TXTMSG:
                    try {
                        if (streembit.Session.curent_viewmodel && streembit.Session.curent_viewmodel.onTextMessage) {
                            streembit.Session.curent_viewmodel.onTextMessage(data);
                        }
                        else {
                            // signal the contact list about the message
                            streembit.Session.contactsvm.onTextMessage(data);
                        }
                    }
                    catch (e) {
                        streembit.notify.error("Error in handling chat message %j", e);
                    }
                    break;

                case streembit.DEFS.PEERMSG_CALL_WEBRTC:
                    //logger.debug("WEBRTC peer message received");
                    events.emit(events.APPEVENT, events.TYPES.ONCALLWEBRTCSIGNAL, data);
                    break;

                case streembit.DEFS.PEERMSG_CALL_WEBRTCSS:
                    //logger.debug("WEBRTC peer message received");
                    events.emit(events.APPEVENT, events.TYPES.ONCALLWEBRTC_SSCSIG, data);
                    break;

                case streembit.DEFS.PEERMSG_CALL_WEBRTCAA:
                    //logger.debug("WEBRTC peer message received");
                    events.emit(events.APPEVENT, events.TYPES.ONCALLWEBRTC_SSAUDIOSIG, data);
                    break;

                case streembit.DEFS.PEERMSG_FILE_WEBRTC:
                    //logger.debug("WEBRTC peer message received");
                    events.emit(events.APPEVENT, events.TYPES.ONFILEWEBRTCSIGNAL, data);
                    break;

                case streembit.DEFS.PEERMSG_FSEND:
                    //logger.debug("PEERMSG_FSEND message received");
                    events.emit(events.APPEVENT, events.TYPES.ONFCHUNKSEND, data);
                    break;

                case streembit.DEFS.PEERMSG_FEXIT:
                    //logger.debug("PEERMSG_FSEND message received");
                    events.emit(events.APPEVENT, events.TYPES.ONFILECANCEL, data);
                    break;

                default:
                    break;
            }
        }
        catch (e) {
            streembit.notify.error("handleSymmMessage error %j", e);
        }
    }
    
    module.onPeerMessage = function (data, info) {
        try {
            if (!streembit.User.is_user_initialized) {
                throw new Error("the application user is not yet initialized");
            }
            
            var msgarray = wotmsg.get_msg_array(data);
            if (!msgarray || !msgarray.length || msgarray.length != 3)
                throw new Error("invalid message");
            
            var header = msgarray[0];
            var payload = msgarray[1];
            if (!payload || !payload.aud)
                throw new Error("invalid aud element");
            
            if (payload.aud != streembit.User.name) {
                throw new Error("aud is " + payload.aud + " invalid for user " + streembit.User.name);
            }
            
            var sender = payload.iss;
            if (!sender)
                throw new Error("invalid sender element");
            
            //  get the public key for the sender only contacts are 
            //  allowed communicate with eachother via peer to peer
            var public_key = streembit.Contacts.get_public_key(sender);
            if (!public_key) {
                if (payload.sub != wotmsg.PEERMSG.ACRQ 
                    && payload.sub != wotmsg.PEERMSG.EXCH 
                    && payload.sub != wotmsg.PEERMSG.AACR 
                    && payload.sub != wotmsg.PEERMSG.DACR 
                    && payload.sub != wotmsg.PEERMSG.PING) {
                    throw new Error("peer message sender '" + sender + "' is not a contact");
                }
                
                if (payload.sub == wotmsg.PEERMSG.ACRQ) {
                    //  if the message is an add contact request then continue as the contact does not exists yet
                    //  get the public key from the payload
                    try {
                        var msgdata = JSON.parse(payload.data);
                        public_key = msgdata.public_key;
                        if (!public_key) {
                            throw new Error("no public key exists in request");
                        }
                    }
                    catch (err) {
                        throw new Error("Add contact request error: " + err.message + ". Contact: " + sender);
                    }
                }
                else if (payload.sub == wotmsg.PEERMSG.EXCH || 
                            payload.sub == wotmsg.PEERMSG.AACR || 
                            payload.sub == wotmsg.PEERMSG.DACR ||
                            payload.sub == wotmsg.PEERMSG.PING) {
                    //  It is possible that the add contact request of this account was received, but the accept reply
                    //  was never received by the account. However, the exchange message indicates that the contact 
                    //  accepted the add contact request.
                    //  If there is a pending contact request then try processing the message
                    
                    // Try to get the public key from the pending contacts list
                    var pending_contact = streembit.Session.get_pending_contact(sender);
                    if (pending_contact) {
                        if (!pending_contact.public_key) {
                            throw new Error("pending contact exists, but there is no public key in the data");
                        }
                        public_key = pending_contact.public_key;
                        if (!public_key) {
                            throw new Error("pending contact exists, but no public key exists for it");
                        }
                    }
                }
            }
            
            var message = wotmsg.decode(data, public_key);
            if (!message || !message.data) {
                throw new Error("invalid JWT message");
            }
            
            if (message.sub == wotmsg.PEERMSG.EXCH || message.sub == wotmsg.PEERMSG.PING) {
                var pending_contact = streembit.Session.get_pending_contact(sender);
                if (pending_contact) {
                    // remove from the pending contacts and add to the contacts list
                    streembit.Contacts.handle_addcontact_accepted(sender);
                }
            }
            
            switch (message.sub) {
                case wotmsg.PEERMSG.EXCH:
                    handleKeyExchange(sender, public_key, payload, message.data);
                    break;
                case wotmsg.PEERMSG.ACCK:
                    handleAcceptKey(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.PING:
                    handlePing(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.PREP:
                    handlePingReply(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.SYMD:
                    handleSymmMessage(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.CALL:
                    handleCall(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.CREP:
                    handleCallReply(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.SSCA:
                    handleShareScreenOffer(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.RSSC:
                    handleShareScreenReply(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.FILE:
                    handleFileInit(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.FREP:
                    handleFileReply(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.HCAL:
                    handleHangupCall(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.ACRQ:
                    handleAddContactRequest(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.AACR:
                    handleAddContactAcceptReply(sender, payload, message.data);
                    break;
                case wotmsg.PEERMSG.DACR:
                    handleAddContactDenyReply(sender, payload, message.data);
                    break;

                default:
                    break;
            }
        }
        catch (err) {
            streembit.notify.error("onPeerMessage error %j", err);
        }
    }
    
    function dequeuemsg(key) {
        var value = msgmap.get(key);
        msgmap.delete(key);
        return value;
    }
    
    //
    //  Wait on certain messages such as the key exchanges and peer session establish operations
    //
    function wait_peer_reply(jti, timeout, showprog) {
        
        return new Promise(function (resolve, reject) {
            
            var waitproc = null;
            
            try {
                console.log("wait_peer_reply jti: " + jti);
                
                var waitForComplete = function (waitms) {
                    var index = 0;
                    var count = parseInt((waitms / 1000)) || 15;
                    waitproc = setInterval(
                        function () {
                            index++;
                            if (index < count) {
                                return;
                            }
                            
                            try {
                                clearTimeout(waitproc);
                                waitproc = null;
                            }
                            catch (e) { }
                            
                            try {
                                if (showprog) {
                                    streembit.notify.hideprogress();
                                }
                                reject("TIMEDOUT");
                                delete list_of_waithandlers[jti];
                            }  
                            catch (e) { }
                        }, 
                        1000
                    );
                    
                    return {
                        jti: jti,
                        waitfunc: waitproc,
                        rejectfunc: reject,
                        resolvefunc: resolve
                    }
                }
                
                var timeoutval = timeout || 15000;
                var waithandler = waitForComplete(timeoutval);
                list_of_waithandlers[jti] = waithandler;
                
                if (showprog) {
                    streembit.notify.showprogress("Waiting reply from peer ... ");
                }
                
                logger.debug("wait peer complete jti: " + jti);
               
            }
            catch (err) {
                if (waitproc) {
                    clearTimeout(waitproc);
                    waitproc = null;
                }
                reject(err);
            }

        });
    }
    
    function exchange_session_key(contact) {
        return new Promise(function (resolve, reject) {
            try {
                
                var account = contact.name;
                
                // Ping must be performed before the key exchange, there fore the ecdh_public must exists at this point
                if (!list_of_sessionkeys[account] || !list_of_sessionkeys[account].contact_ecdh_public) {
                    return reject("contact ecdh public key doesn't exists. Must PING first to get the ecdh public key.");
                }
                
                var ecdh_public = list_of_sessionkeys[account].contact_ecdh_public; //contact.ecdh_public;
                
                // create a symmetric key for the session
                var random_bytes = secrand.randomBuffer(32);
                var session_symmkey = nodecrypto.createHash('sha256').update(random_bytes).digest().toString('hex');
                
                logger.debug("exchange symm key %s with contact %s", session_symmkey, account);
                logger.debug("using ecdh public key %s", ecdh_public);
                
                var plaindata = { symmetric_key: session_symmkey };
                var cipher = wotmsg.ecdh_encypt(streembit.User.ecdh_key, ecdh_public, plaindata);
                
                var data = {
                    account: streembit.User.name, 
                    public_key: streembit.User.public_key,
                    ecdh_public_key: streembit.User.ecdh_public_key, 
                    address: streembit.User.address, 
                    port: streembit.User.port
                };
                data[wotmsg.MSGFIELD.DATA] = cipher;
                
                var jti = streembit.Message.create_id();
                var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.EXCH, jti, streembit.User.private_key, data, streembit.User.name, account);
                streembit.Node.peer_send(contact, encoded_msgbuffer);
                
                //  insert the session key into the list
                list_of_sessionkeys[account] = {
                    symmetric_key: session_symmkey,
                    contact_ecdh_public: contact.ecdh_public,
                    contact_public_key: contact.public_key,
                    timestamp: Date.now(),
                    accepted: false
                };
                
                resolve(jti);
            }
            catch (err) {
                reject(err);
            }
        });
    }
    
    module.send_offline_message = function (contact, message, msgtype, callback) {
        try {
            if (!contact) {
                throw new Error("invalid contact parameter");
            }
            if (!message) {
                throw new Error("invalid message parameter");
            }
            
            var account = contact.name;
            var rcpt_ecdh_public_key = contact.ecdh_public;
            
            var plaindata = { message: message };
            var cipher = wotmsg.ecdh_encypt(streembit.User.ecdh_key, rcpt_ecdh_public_key, plaindata);
            
            var timestamp = Date.now();
            var payload = {};
            payload.type = wotmsg.MSGTYPE.OMSG;
            payload[wotmsg.MSGFIELD.PUBKEY] = streembit.User.public_key;
            payload[wotmsg.MSGFIELD.SEKEY] = streembit.User.ecdh_public_key;
            payload[wotmsg.MSGFIELD.REKEY] = rcpt_ecdh_public_key;
            payload[wotmsg.MSGFIELD.TIMES] = timestamp;
            payload[wotmsg.MSGFIELD.CIPHER] = cipher;
            payload[wotmsg.MSGFIELD.MSGTYPE] = msgtype;
            
            var jti = streembit.Message.create_id();
            var value = wotmsg.create(streembit.User.private_key, jti, payload, null, null, streembit.User.name, null, account);
            var key = account + "/message/" + jti;
            // put the message to the network
            streembit.Node.put(key, value, function (err) {
                if (err) {
                    return streembit.notify.error("Send off-line message error %j", err);
                }
                logger.debug("sent off-line message " + key);
                callback();
            });
        }
        catch (e) {
            streembit.notify.error("send_offline_message error %j", e);
        }
    }
    
    module.addcontact_message = function (contact, callback) {
        try {
            if (!contact) {
                throw new Error("invalid contact parameter");
            }
            
            var account = contact.name;
            
            var timestamp = Date.now();
            var payload = {};
            payload.type = wotmsg.MSGTYPE.OMSG;
            payload[wotmsg.MSGFIELD.PUBKEY] = streembit.User.public_key;
            payload[wotmsg.MSGFIELD.SEKEY] = streembit.User.ecdh_public_key;
            payload[wotmsg.MSGFIELD.TIMES] = contact.addrequest_create || Date.now();
            payload[wotmsg.MSGFIELD.MSGTYPE] = streembit.DEFS.MSG_ADDCONTACT;
            
            var hashdata = account + "/message/" + streembit.DEFS.MSG_ADDCONTACT + "/" + streembit.User.name;
            var jti = streembit.Message.create_hash_id(hashdata);
            var value = wotmsg.create(streembit.User.private_key, jti, payload, null, null, streembit.User.name, null, account);
            var key = account + "/message/" + jti;
            // put the message to the network
            streembit.Node.put(key, value, function (err) {
                if (err) {
                    return streembit.notify.error("Send off-line message error %j", err);
                }
                logger.debug("sent persistent addcontact request " + key);
                callback();
            });
        }
        catch (e) {
            streembit.notify.error("send_offline_message error %j", e);
        }
    }
    
    module.declinecontact_message = function (contact, callback) {
        try {
            if (!contact) {
                throw new Error("invalid contact parameter");
            }
            
            var account = contact.name;
            
            var timestamp = Date.now();
            var payload = {};
            payload.type = wotmsg.MSGTYPE.OMSG;
            payload[wotmsg.MSGFIELD.PUBKEY] = streembit.User.public_key;
            payload[wotmsg.MSGFIELD.SEKEY] = streembit.User.ecdh_public_key;
            payload[wotmsg.MSGFIELD.TIMES] = contact.addrequest_create || Date.now();
            payload[wotmsg.MSGFIELD.MSGTYPE] = streembit.DEFS.MSG_DECLINECONTACT;
            
            var hashdata = account + "/message/" + streembit.DEFS.MSG_DECLINECONTACT + "/" + streembit.User.name;
            var jti = streembit.Message.create_hash_id(hashdata);
            var value = wotmsg.create(streembit.User.private_key, jti, payload, null, null, streembit.User.name, null, account);
            var key = account + "/message/" + jti;
            // put the message to the network
            streembit.Node.put(key, value, function (err) {
                if (err) {
                    return streembit.notify.error("declinecontact_message error %j", err);
                }
                logger.debug("sent persistent declinecontact_message request " + key);
                callback();
            });
        }
        catch (e) {
            streembit.notify.error("declinecontact_message error %j", e);
        }
    }
    
    module.send_peer_message = function (contact, message) {
        try {
            //logger.debug("send_peer_message()");
            
            if (!contact) {
                throw new Error("invalid contact parameter");
            }
            if (!message) {
                throw new Error("invalid message parameter");
            }
            
            var account = contact.name;
            var session = list_of_sessionkeys[account];
            if (!session && !session.accepted && !session.symmetric_key) {
                throw new Error("contact session key doesn't exists");
            }
            
            var jti = streembit.Message.create_id();
            var encoded_msgbuffer = wotmsg.create_symm_msg(wotmsg.PEERMSG.SYMD, jti, streembit.User.private_key, session.symmetric_key, message, streembit.User.name, account);
            streembit.Node.peer_send(contact, encoded_msgbuffer);
        }
        catch (e) {
            streembit.notify.error("send_peer_message error %j", e);
        }
    }
    
    module.ping = function (contact, showprogress, timeout) {
        
        return new Promise(function (resolve, reject) {
            try {
                
                var account = contact.name;
                var data = {}
                data[wotmsg.MSGFIELD.TIMES] = Date.now();
                data[wotmsg.MSGFIELD.ECDHPK] = streembit.User.ecdh_public_key;
                data[wotmsg.MSGFIELD.PROTOCOL] = config.transport;
                data[wotmsg.MSGFIELD.HOST] = streembit.User.address;
                data[wotmsg.MSGFIELD.PORT] = streembit.User.port;
                
                var jti = streembit.Message.create_id();
                var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.PING, jti, streembit.User.private_key, data, streembit.User.name, account);
                streembit.Node.peer_send(contact, encoded_msgbuffer);
                
                var timeoutval = timeout || 10000;
                wait_peer_reply(jti, timeoutval, showprogress)
                .then(
                    function () {
                        resolve();
                    },
                    function (err) {
                        reject(err);
                    }                    
                );
            }
            catch (err) {
                reject(err);
            }
        });
    }
    
    module.send_addcontact_request = function (contact) {
        try {
            var account = contact.name;
            var data = { sender: streembit.User.name };
            data[wotmsg.MSGFIELD.PUBKEY] = streembit.User.public_key;
            data[wotmsg.MSGFIELD.ECDHPK] = streembit.User.ecdh_public_key;
            data[wotmsg.MSGFIELD.PROTOCOL] = config.transport;
            data[wotmsg.MSGFIELD.HOST] = streembit.User.address;
            data[wotmsg.MSGFIELD.PORT] = streembit.User.port;
            data[wotmsg.MSGFIELD.UTYPE] = streembit.DEFS.USER_TYPE_HUMAN;
            
            var jti = streembit.Message.create_id();
            var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.ACRQ, jti, streembit.User.private_key, data, streembit.User.name, account);
            streembit.Node.peer_send(contact, encoded_msgbuffer);
        }
        catch (err) {
            streembit.notify.error("send_addcontact_request error:  %j", err);
        }
    }
    
    module.send_accept_addcontact_reply = function (contact) {
        try {
            var account = contact.name;
            var data = { sender: streembit.User.name };
            
            var jti = streembit.Message.create_id();
            var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.AACR, jti, streembit.User.private_key, data, streembit.User.name, account);
            streembit.Node.peer_send(contact, encoded_msgbuffer);
        }
        catch (err) {
            streembit.notify.error("send_addcontact_request error:  %j", err);
        }
    }
    
    module.send_decline_addcontact_reply = function (contact) {
        try {
            var account = contact.name;
            var data = { sender: streembit.User.name };
            
            var jti = streembit.Message.create_id();
            var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.DACR, jti, streembit.User.private_key, data, streembit.User.name, account);
            streembit.Node.peer_send(contact, encoded_msgbuffer);
        }
        catch (err) {
            streembit.notify.error("send_addcontact_request error:  %j", err);
        }
    }
    
    module.hangup_call = function (contact) {
        
        return new Promise(function (resolve, reject) {
            try {
                var account = contact.name;
                var data = {}
                data[wotmsg.MSGFIELD.TIMES] = Date.now();
                
                var jti = streembit.Message.create_id();
                var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.HCAL, jti, streembit.User.private_key, data, streembit.User.name, account);
                streembit.Node.peer_send(contact, encoded_msgbuffer);
                
                // don't wait for reply
            }
            catch (err) {
                reject(err);
            }
        });
    }
    
    module.call = function (contact, type, showprogress) {
        
        return new Promise(function (resolve, reject) {
            try {
                
                var account = contact.name;
                var data = {}
                data[wotmsg.MSGFIELD.CALLT] = type;
                
                var jti = streembit.Message.create_id();
                var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.CALL, jti, streembit.User.private_key, data, streembit.User.name, account);
                streembit.Node.peer_send(contact, encoded_msgbuffer);
                
                wait_peer_reply(jti, 10000, showprogress)
                .then(
                    function (isaccepted) {
                        resolve(isaccepted);
                    },
                    function (err) {
                        reject(err);
                    }                    
                );
            }
            catch (err) {
                reject(err);
            }
        });
    }
    
    module.offer_sharescreen = function (contact, resolve, reject) {
        try {
            var account = contact.name;
            var data = {}
            data[wotmsg.MSGFIELD.TIMES] = Date.now();
            
            var jti = streembit.Message.create_id();
            var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.SSCA, jti, streembit.User.private_key, data, streembit.User.name, account);
            streembit.Node.peer_send(contact, encoded_msgbuffer);
            
            //console.log("offer_sharescreen jti:" + jti);
            
            wait_peer_reply(jti, 15000, true).then(resolve, reject);
                          
        }
        catch (err) {
            reject(err);
        }
    }
    
    module.initfile = function (contact, file, showprogress, timeout) {
        
        return new Promise(function (resolve, reject) {
            try {
                
                var account = contact.name;
                var data = {}
                data[wotmsg.MSGFIELD.CALLT] = streembit.DEFS.CALLTYPE_FILET;
                data.file_name = file.name;
                data.file_size = file.size;
                data.file_hash = file.hash;
                data.file_type = file.type;
                
                var jti = streembit.Message.create_id();
                var encoded_msgbuffer = wotmsg.create_msg(wotmsg.PEERMSG.FILE, jti, streembit.User.private_key, data, streembit.User.name, account);
                streembit.Node.peer_send(contact, encoded_msgbuffer);
                
                wait_peer_reply(jti, timeout || 30000, showprogress)
                .then(
                    function (isaccepted) {
                        resolve(isaccepted);
                    },
                    function (err) {
                        reject(err);
                    }                    
                );
            }
            catch (err) {
                reject(err);
            }
        });
    }
    
    module.is_peer_session = function (account) {
        var val = list_of_sessionkeys[account];
        return val ? true : false;
    }
    
    module.get_account_messages = function (msgkey) {
        try {
            logger.debug("get_account_messages");
            
            streembit.Node.get_account_messages(streembit.User.name, msgkey, function (err, result) {
                if (err) {
                    return streembit.notify.error("get_account_messages error:  %j", err);
                }
                
                events.emit(events.APPEVENT, events.TYPES.ONACCOUNTMSG, result);
            });
        }
        catch (e) {
            streembit.notify.error("get_account_messages error:  %j", e);
        }
    }
    
    module.delete_item = function (key, request) {
        try {
            streembit.Node.delete_item(key, request);
        }
        catch (e) {
            streembit.notify.error("delete_item error:  %j", e);
        }
    }
    
    module.delete_message = function (msgid, callback) {
        try {
            if (!msgid) {
                return callback("delete_message error: invalid msgid")
            }
            
            var payload = {};
            payload.type = wotmsg.MSGTYPE.DELMSG;
            payload[wotmsg.MSGFIELD.MSGID] = msgid
            
            var jti = streembit.Message.create_id();
            var value = wotmsg.create(streembit.User.private_key, jti, payload, null, null, streembit.User.name);
            
            var key = streembit.User.name + "/delmsg/" + msgid;
            // put the message to the network
            streembit.Node.put(key, value, function (err) {
                callback(err);
            });
        }
        catch (e) {
            streembit.notify.error("delete_message error:  %j", e);
        }
    }
    
    module.delete_public_key = function (callback) {
        try {
            //  publishing user data
            if (!streembit.User.public_key || !streembit.User.ecdh_public_key || !streembit.User.address || !streembit.User.port) {
                return callback("invalid user context data");
            }
            
            //  publish the public keys so this client can communicate with the devices
            //  via direct peer to peer messaging as well
            // create the WoT message 
            var payload = {};
            payload.type = wotmsg.MSGTYPE.DELPK;
            payload[wotmsg.MSGFIELD.PUBKEY] = streembit.User.public_key;
            
            logger.debug("publish delete key: %j", payload);
            
            var value = wotmsg.create(streembit.User.private_key, streembit.Message.create_id(), payload);
            var key = streembit.User.name;
            
            //  For this public key upload message the key is the device name
            streembit.Node.put(key, value, function (err) {
                if (err) {
                    return callback(err);
                }
                
                logger.debug("peer update public key published");
                //  the public key has been uplodad, other peers can verify the messages -> ready to process device messages
                callback();
            });
        }
        catch (e) {
            callback(e);
        }
    }
    
    module.update_public_key = function (new_public_key, callback) {
        try {
            //  publishing user data
            if (!streembit.User.public_key || !streembit.User.ecdh_public_key || !streembit.User.address || !streembit.User.port) {
                return callback("invalid user context data");
            }
            
            if (!new_public_key) {
                return callback("invalid new public key");
            }
            
            //  publish the public keys so this client can communicate with the devices
            //  via direct peer to peer messaging as well
            // create the WoT message 
            var payload = {};
            payload.type = wotmsg.MSGTYPE.UPDPK;
            payload[wotmsg.MSGFIELD.PUBKEY] = new_public_key;
            payload[wotmsg.MSGFIELD.LASTPKEY] = streembit.User.public_key;
            payload[wotmsg.MSGFIELD.ECDHPK] = streembit.User.ecdh_public_key;
            payload[wotmsg.MSGFIELD.PROTOCOL] = config.transport;
            payload[wotmsg.MSGFIELD.HOST] = streembit.User.address;
            payload[wotmsg.MSGFIELD.PORT] = streembit.User.port;
            payload[wotmsg.MSGFIELD.UTYPE] = streembit.DEFS.USER_TYPE_HUMAN;
            
            logger.debug("publish update key: %j", payload);
            
            var value = wotmsg.create(streembit.User.private_key, streembit.Message.create_id(), payload);
            var key = streembit.User.name;
            
            //  For this public key upload message the key is the device name
            streembit.Node.put(key, value, function (err) {
                if (err) {
                    return callback(err);
                }
                
                logger.debug("peer update public key published");
                //  the public key has been uplodad, other peers can verify the messages -> ready to process device messages
                callback();
            });
        }
        catch (e) {
            callback(e);
        }
    }
    
    module.publish_account = function (callback) {
        try {
            if (!callback) {
                return streembit.notify.error("publish_user error: invalid callback parameter")
            }
            
            //  publishing user data
            if (!streembit.account.public_key || !streembit.account.ecdh_public_key || !streembit.account.address || !streembit.account.port) {
                return callback("invalid user context data");
            }
            
            //  publish the public keys so this client can communicate with the devices
            //  via direct peer to peer messaging as well
            // create the WoT message 
            var payload = {};
            payload.type = wotmsg.MSGTYPE.PUBPK;
            payload[wotmsg.MSGFIELD.PUBKEY] = streembit.account.public_key;
            payload[wotmsg.MSGFIELD.ECDHPK] = streembit.account.ecdh_public_key;
            payload[wotmsg.MSGFIELD.PROTOCOL] = config.transport;
            payload[wotmsg.MSGFIELD.HOST] = streembit.account.address;
            payload[wotmsg.MSGFIELD.PORT] = streembit.account.port;
            payload[wotmsg.MSGFIELD.UTYPE] = streembit.DEFS.USER_TYPE_HUMAN;
            
            logger.debug("publish account: %j", payload);
            
            var value = wotmsg.create(streembit.account.private_key, streembit.Message.create_id(), payload);
            var key = streembit.account.name;
            
            //  For this public key upload message the key is the device name
            streembit.Node.put(key, value, function (err, results) {
                if (err) {
                    return callback("Publish user error: " + (err.message ? err.message : err));
                }
                
                if (results && results.length) {
                    var success = false;
                    for (var i = 0; i < results.length; i++) {
                        var contact_account = (results[i].contact && results[i].contact.account) ? results[i].contact.account : "unknown";
                        var contact_address = (results[i].contact && results[i].contact.address) ? results[i].contact.address : "unknown";
                        var contact_port = (results[i].contact && results[i].contact.port) ? results[i].contact.port : "unknown";
                        if (results[i].status != 0) {
                            var error = (results[i].error && results[i].error.message)  ? results[i].error.message : "unknown error";
                            logger.info("Error in publishing account public key at contact account: " + contact_account + ", address: " + contact_address + ", port: " + contact_port + ". Error: " + error);
                        }
                        else {
                            //  at least one node has succeeded so the operation completed
                            logger.debug("Published account public key at contact account:" + contact_account + ", address: " + contact_address + ", port: " + contact_port + " completed");
                            success = true;
                        }
                    }
                    
                    if (!success) {
                        return callback("Publish account error: the account info was not published to any seeds.");
                    }
                }
                
                logger.debug("peer published");
                
                callback();
                
                //
            });
        }
        catch (e) {
            callback("Publish peer user error: " + e.message);
        }
    }
    
    module.session = function (account) {
        var session = list_of_sessionkeys[account];
        if (session && session.accepted && session.symmetric_key) {
            //  the session is already exists
            return session;
        }
        else {
            return null;
        }
    }
    
    module.get_contact_session = function (contact, showprog) {
        
        return new Promise(function (resolve, reject) {
            try {
                var account = contact.name;
                
                // create the session
                exchange_session_key(contact)
                .then(
                    function (jti) {
                        return wait_peer_reply(jti, 5000, showprog || false);
                    },
                    function (err) {
                        reject(err);
                    }
                )
                .then(
                    function (data) {
                        //  must be the data in the session list
                        var session = list_of_sessionkeys[account];
                        resolve(session);
                    },
                    function (err) {
                        reject(err);
                    }
                )
            }
            catch (err) {
                reject(err);
            }
        });
    }
    
    module.validate_connection = function () {
        return new Promise(function (resolve, reject) {
            streembit.Node.validate_connection(function (err) {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }
    
    module.init = function (seeds, db) {
        return new Promise(function (resolve, reject) {
            streembit.Node.init(seeds, db, function (err, result) {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }
    
    
    return module;

}(streembit.PeerNet || {}, global.applogger, global.appevents, streembit.config));

//  exports
module.exports.PeerNet = streembit.PeerNet;
module.exports.Message = streembit.Message;

