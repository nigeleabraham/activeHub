const express = require('express');
const CourseOrders = require('../models/CourseOrders');
const Settings = require('../models/Settings');

module.exports = function courseBasketRoutes({ simulateCardPayment }) {
    const router = express.Router();
    const money = pence => `£${(pence / 100).toFixed(2)}`;

    async function renderBasket(req, res, { checkout = false, message = '', status = 200 } = {}) {
        const [basket, settings, logo, orders] = await Promise.all([
            CourseOrders.basket(req.profile.guid), Settings.getAll(), Settings.getLogo(), CourseOrders.orders(req.profile.guid)
        ]);
        if (checkout && basket.valid) {
            return res.status(status).render('resident-checkout', {
                activePage: 'basket', siteTitle: settings.site_title, hasLogo: Boolean(logo),
                basket, total: money(basket.total), credit: money(basket.credit), due: money(basket.due),
                fullyCovered: basket.due === 0, cardError: message, values: {}
            });
        }
        return res.status(status).render('resident-basket', {
            activePage: 'basket', siteTitle: settings.site_title, hasLogo: Boolean(logo),
            basket, checkout: checkout && basket.valid, message, money, orders
        });
    }

    router.get('/basket', async (req, res, next) => {
        try { return await renderBasket(req, res); } catch (error) { next(error); }
    });
    router.post('/basket/add', async (req, res, next) => {
        try {
            await CourseOrders.add(req.profile.guid, req.body.run_guid, req.body.member_guid, req.body.return_to);
            return req.body.checkout === '1' ? res.redirect(303, '/basket/checkout') : res.redirect('/basket');
        } catch (error) {
            if (error instanceof CourseOrders.BasketError) return renderBasket(req, res, { message: error.message, status: 409 });
            next(error);
        }
    });
    router.post('/basket/remove', async (req, res, next) => {
        try {
            await CourseOrders.remove(req.profile.guid, req.body.item_guid);
            return res.redirect('/basket');
        } catch (error) {
            if (error instanceof CourseOrders.BasketError) return renderBasket(req, res, { message: error.message, status: 409 });
            next(error);
        }
    });
    async function checkout(req, res, next) {
        try { return await renderBasket(req, res, { checkout: true }); } catch (error) { next(error); }
    }
    router.get('/basket/checkout', checkout);
    router.post('/basket/checkout', checkout);
    router.post('/basket/pay', async (req, res, next) => {
        try {
            const { token, total, credit } = req.body;
            if (typeof total !== 'string' || !/^\d{1,10}$/.test(total) ||
                typeof credit !== 'string' || !/^\d{1,9}$/.test(credit) || Number(credit) > Number(total)) {
                return await renderBasket(req, res, { message: 'Reload the basket and review your payment.', status: 400 });
            }
            const payment = Number(total) > Number(credit) ? simulateCardPayment(req.body) : { reference: 'CREDIT' };
            if (payment.error) return await renderBasket(req, res, { checkout: true, message: payment.error, status: 422 });
            const order = await CourseOrders.pay(req.profile.guid, token,
                { total: Number(total), credit: Number(credit) }, payment.reference);
            return res.redirect(`/course-orders/${order.guid}`);
        } catch (error) {
            if (error instanceof CourseOrders.BasketError || error.code === 'INSUFFICIENT_CREDIT') {
                return renderBasket(req, res, { message: error instanceof CourseOrders.BasketError
                    ? error.message : 'Your available credit changed. Review your basket and try again.', status: 409 });
            }
            next(error);
        }
    });
    router.get('/course-orders/:guid', async (req, res, next) => {
        try {
            const [order, settings, logo] = await Promise.all([
                CourseOrders.order(req.profile.guid, req.params.guid), Settings.getAll(), Settings.getLogo()
            ]);
            if (!order) return res.sendStatus(404);
            return res.render('resident-course-order', {
                activePage: 'basket', siteTitle: settings.site_title, hasLogo: Boolean(logo), order, money
            });
        } catch (error) { next(error); }
    });
    router.post('/profile/family-members', async (req, res, next) => {
        try {
            await CourseOrders.addFamilyMember(req.profile.guid, req.body.name);
            return res.redirect('/profile?family_saved=1#my-children');
        } catch (error) {
            if (error instanceof CourseOrders.BasketError) return res.redirect('/profile?family_error=1#my-children');
            next(error);
        }
    });
    router.post('/profile/family-members/remove', async (req, res, next) => {
        try {
            await CourseOrders.removeFamilyMember(req.profile.guid, req.body.guid);
            return res.redirect('/profile?family_saved=1#my-children');
        } catch (error) {
            if (error instanceof CourseOrders.BasketError) return res.redirect('/profile?family_error=1#my-children');
            next(error);
        }
    });
    return router;
};
