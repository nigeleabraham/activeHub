const express = require('express');
const Todo = require('./../models/Todo');

const router = express.Router();

// Home page route
router.get('/', async (req, res) => {
    try {
        const todos = await Todo.findAll();
        res.render('todos', { tasks: todos });
    } catch (error) {
        res.sendStatus(500);
    }
});

// POST - Submit Task
router.post('/', async (req, res) => {
    const task = req.body.task;
    if (typeof task !== 'string' || !task.trim()) {
        return res.sendStatus(400);
    }

    try {
        await Todo.create(task.trim());
        res.redirect('/');
    } catch (error) {
        res.sendStatus(500);
    }
});

// POST - Destroy todo item
router.post('/todo/destroy', async (req, res) => {
    const id = req.body.id;
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
        return res.sendStatus(400);
    }

    try {
        await Todo.remove(id);
        res.redirect('/');
    } catch (error) {
        res.sendStatus(500);
    }
});


module.exports = router;