var express = require('express');
var fs = require('fs');

var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var session = require('express-session');

var app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extend: true
}));
app.use(cookieParser());
app.use(session({secret: "my secret"}));

var mongoose = require('mongoose');

mongoose.connect('mongodb://127.0.0.1/simplechat');
//app.listen(3000, function() {
//    console.log('\033[96m + \033[39m app listening on *:3000');
//});

// Models
var Schema = mongoose.Schema;
var User = mongoose.model('User', new Schema({
    first: String,
    last: String,
    username: {type: String, unique: true},
    password: {type: String, index: true},
    online: Boolean
}));

var Conversation = mongoose.model('Conversation', new Schema({
    from: String,
    to: String,
    messages: [{type: Schema.Types.Mixed}]
}));

var Message = mongoose.model('Message', new Schema({
    content: String,
    author: String,
    username: String,
    date: Date
}));

app.use(function(req, res, next) {
    res = responseFilter(req,res);

    if (req.session.loggedIn) {
        res.locals.authenticated = true;
        User.findById(req.session.loggedIn, function(err, doc) {
            if (err)
                return next(err);
            res.locals.me = doc;
            next();
        });
    } else {
        res.locals.authenticated = false;
        next();
    }
});

// Default
app.get('/api/index', function (req, res) {
    if (req.session.loggedIn)
        Message.find(function(err, msg) {
            if (err)
                return next(err);
            req.session.chat_msg = msg;
            res.send({authenticated: true, me: req.session.doc, chat_msg: req.session.chat_msg});
        }).sort({date: -1}).limit(4);
    else
        res.send({authenticated: false});
});

var responseFilter = function(req,res) {
    res.header('Access-Control-Allow-Origin', req.get("origin"));
    res.header("Content-Type", "application/json");
    res.header("Access-Control-Allow-Headers", "accept, content-type");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
    return res;
}

app.options("/*", function(req, res, next){
    res.sendStatus(200);
});

app.post('/api/login', function (req, res) {
    User.findOne({ username: req.body.user.username, password: req.body.user.password }, {first: true, last: true, username: true}, function(err, doc) {
        if (err)
            return next(err);
        if (!doc)
            return res.send('<p>User not found. Go back and try again</p>');

        req.session.loggedIn = doc._id.toString();
        req.session.doc = doc;
        Message.find(function(err, msg) {
            if (err)
                return next(err);
            req.session.chat_msg = msg;
            res.send({authenticated: true, me: doc, chat_msg: msg});
        }).sort({date: -1}).limit(4);
    });
});

app.post('/api/signup', function (req, res) {
    var user = new User(req.body.user).save(function(err, doc) {
        if (err) {
            console.log(err);
            return next(err);
        }

        res.send(doc);
    });
});

app.get('/api/logout', function(req, res) {
    req.session.loggedIn = null;
    req.session.doc = null;
    res.send({out: true});
});

app.get('/api/friends', function (req, res) {
    var rooms = io.sockets.adapter.rooms;

    User.find({username: {$not: {$eq: res.locals.me.username}}}, {first: true, last: true, username: true}, function(err, doc) {
        if (err)
            return res.send(false);
        if (!doc)
            return res.send(false);

        for (var index = 0; index < doc.length; index++) {
            if (!rooms[doc[index]._id]) {
                doc[index].set("online", false);
            }
            else {
                doc[index].set("online", true);
            }
        }

        res.send({friends: doc});
    });
});

app.get('/api/conversation', function (req, res) {
    var to = req.query.id;
    var from = res.locals.me._id;
    Conversation.findOne({$or: [{from: from, to: to}, {from: to, to: from}]}, function(err, conv) {
        if (err)
            return res.send(false);
        res.send(conv);
    });
});

var http = require('http');
var sio = require('socket.io');
var server = http.createServer(app);
var io = sio.listen(server.listen(8000));
var allClients = [];
io.sockets.on('connection', function(socket) {
    allClients.push(socket);

    socket.on('join', function(user) {
        if (!user || !user.username)
            return;

        socket.name = user.first + ' ' + user.last;
        socket.username = user.username;
        socket.join(user._id);
        socket.broadcast.emit('announcement', {
            message: socket.name + ' is online.',
            user: {
                username: socket.username,
                online: true
            }
        });
    });

    socket.on('signup', function(user) {
        if (!user || !user.username)
            return;

        socket.broadcast.emit('newuser', user);
        allClients.splice(allClients.indexOf(socket), 1);
    });

    socket.on('disconnect', function(user) {
        if (!user || !user.username)
            return;

        var name = user.first + ' ' + user.last;
        allClients.splice(allClients.indexOf(socket), 1);
        socket.broadcast.emit('announcement', {
            message: name + ' is offline.',
            user: {
                username: user.username,
                online: false
            }
        });
    });

    socket.on('text', function(msg, fn) {
        var date = Date.now();
        // socket.broadcast.to(msg.from).emit('text', {author: socket.name, username: socket.username, content: msg.content, date: date}, msg.content);
        socket.broadcast.to(msg.to).emit('text', {author: socket.name, username: socket.username, content: msg.content, date: date}, msg.content);

        var message = {content: msg.content, author: socket.name, username: socket.username, date: date};

        saveMessage(message,msg.from,msg.to);

        // confirm the reception
        fn(date);
    });

    socket.on('typingMessage', function(friend) {
        socket.broadcast.to(friend._id).emit('typingMessage', socket.username);
    });

    socket.on('noLongerTypingMessage', function(friend) {
        socket.broadcast.to(friend._id).emit('noLongerTypingMessage', socket.username);
    });
});

function saveMessage(message,from,to) {
    var newMessage = new Message(message).save(function(err, msg) {
        if (err)
            return false;
        console.log(msg);

        return Conversation.findOne({$or: [{from: from, to: to}, {from: to, to: from}]}, function(err, conversation) {
            if (err) {
                return false;
            }

            if (!conversation) {
                var newCon = {from: from, to: to, messages: [msg]}
                return new Conversation(newCon).save(function(err, updatedConversation) {
                    if (err)
                        return false;
                    return updatedConversation;
                });
            } else {
                if (conversation.messages == undefined)
                    conversation.messages = [];

                conversation.messages.push(msg);
                return conversation.save(function(err, updatedConversation) {
                    if (err)
                        return false;
                    return updatedConversation;
                });
            }
        });
    });
}