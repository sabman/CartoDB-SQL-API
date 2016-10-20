'use strict';

// Inspiration from:
// - https://www.kernel.org/doc/Documentation/scheduler/sched-design-CFS.txt
// - https://www.kernel.org/doc/Documentation/rbtree.txt
// - http://www.ibm.com/developerworks/linux/library/l-completely-fair-scheduler/

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var RBTree = require('bintrees').RBTree;

var debug = require('../util/debug')('scheduler');

var forever = require('../util/forever');

function Scheduler(capacity, taskRunner) {
    EventEmitter.call(this);
    debug('new Scheduler');
    this.taskRunner = taskRunner;
    this.capacity = capacity;
    this.tasks = [];
    this.users = {};
    this.tasksTree = new RBTree(function(taskEntityA, taskEntityB) {
        // if the user is the same it's the same entity
        if (taskEntityA.user === taskEntityB.user) {
            return 0;
        }

        // priority for entity with less executed jobs
        if (taskEntityA.jobs !== taskEntityB.jobs) {
            return taskEntityA.jobs - taskEntityB.jobs;
        }

        // priority for oldest job
        if (taskEntityA.createdAt !== taskEntityB.createdAt) {
            return taskEntityA.createdAt - taskEntityB.createdAt;
        }

        // we don't care if we arrive here
        return -1;
    });
}
util.inherits(Scheduler, EventEmitter);

module.exports = Scheduler;

Scheduler.prototype.add = function(user) {
    debug('add(%s)', user);
    var taskEntity = this.users[user];
    if (taskEntity) {
        if (taskEntity.status === STATUS.DONE) {
            taskEntity.status = STATUS.PENDING;
        }

        return true;
    } else {
        taskEntity = new TaskEntity(user, this.tasks.length);
        this.tasks.push(taskEntity);
        this.users[user] = taskEntity;
        this.tasksTree.insert(taskEntity);

        this.emit('add');

        return false;
    }
};

Scheduler.prototype.schedule = function() {
    if (this.running) {
        return true;
    }
    this.running = true;

    var self = this;
    forever(
        function (next) {
            debug('Waiting for task');
            self.acquire(function(err, taskEntity) {
                debug('Acquired user=%j', taskEntity);

                if (!taskEntity) {
                    return next(new Error('all users finished'));
                }

                self.tasksTree.remove(taskEntity);
                taskEntity.running();

                debug('Running task for user=%s', taskEntity.user);
                self.taskRunner.run(taskEntity.user, function(err, userQueueIsEmpty) {
                    debug('Run task=%j, done=%s', taskEntity, userQueueIsEmpty);
                    taskEntity.ran(userQueueIsEmpty);
                    self.release(err, taskEntity);
                });

                // try to acquire next user
                // will block until capacity slot is available
                next();
            });
        },
        function (err) {
            debug('done: %s', err.message);
            self.running = false;
            self.emit('done');
            self.removeAllListeners();
        }
    );

    return false;
};

Scheduler.prototype.acquire = function(callback) {
    if (this.tasks.every(is(STATUS.DONE))) {
        return callback(null, null);
    }

    var self = this;
    this.capacity.getCapacity(function(err, capacity) {
        if (err) {
            return callback(err);
        }

        function addListener() {
            self.removeListener('release', releaseListener);
            debug('Got a new task');
            self.acquire(callback);
        }

        function releaseListener() {
            self.removeListener('add', addListener);
            debug('Slot was released');
            self.acquire(callback);
        }

        debug('Trying to acquire task');

        var allRunning = self.tasks.every(is(STATUS.RUNNING));
        var running = self.tasks.filter(is(STATUS.RUNNING));
        debug('[capacity=%d, running=%d, all=%s] candidates=%j', capacity, running.length, allRunning, self.tasks);

        if (allRunning && running.length < capacity) {
            debug('Waiting for tasks');
            self.once('add', addListener);
        }

        var isRunningAny = self.tasks.some(is(STATUS.RUNNING));
        if (isRunningAny || running.length >= capacity) {
            debug('Waiting for slot');
            return self.once('release', releaseListener);
        }

        var candidate = self.tasksTree.min();

        return callback(null, candidate);
    });
};

Scheduler.prototype.release = function(err, taskEntity) {
    debug('Released %j', taskEntity);
    if (taskEntity.is(STATUS.PENDING)) {
        this.tasksTree.insert(taskEntity);
    }
    this.emit('release');
};


/* Task entities */

var STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    DONE: 'done'
};

function TaskEntity(user, createdAt) {
    this.user = user;
    this.createdAt = createdAt;
    this.status = STATUS.PENDING;
    this.jobs = 0;
    this.runAt = 0;
}

TaskEntity.prototype.is = function(status) {
    return this.status === status;
};

TaskEntity.prototype.running = function() {
    this.status = STATUS.RUNNING;
    this.runAt = Date.now();
};

TaskEntity.prototype.ran = function(userQueueIsEmpty) {
    this.jobs++;
    this.status = userQueueIsEmpty ? STATUS.DONE : STATUS.PENDING;
};

function is(status) {
    return function(taskEntity) {
        return taskEntity.is(status);
    };
}
