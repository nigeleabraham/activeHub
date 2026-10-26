const express = require('express');
const Children = require('../models/Children');
const Profiles = require('../models/Profiles');
const Sports = require('../models/Sports');
const Settings = require('../models/Settings');
const AuditLog = require('../models/AuditLog');
const ProfileSections = require('../models/ProfileSections');

const router = express.Router();

async function render(req, res, child, error = '', status = 200) {
    const [parent, sports, settings, logo] = await Promise.all([
        Profiles.findByGuid(req.profile.guid), Sports.findAll(), Settings.getAll(), Settings.getLogo()
    ]);
    if (!parent) return res.sendStatus(404);
    return res.status(status).render('resident-child', {
        activePage: 'profile', siteTitle: settings.site_title, hasLogo: Boolean(logo),
        membershipScheme: settings.membership_scheme, parent, child, sports, error,
        resolved: Children.resolve(child, parent)
    });
}

router.get('/profile/children/new', async (req, res, next) => {
    try {
        return await render(req, res, { inherit_address: true, inherit_parental_contact: true, inherit_emergency_contact: true });
    } catch (error) { next(error); }
});

router.get('/profile/children/:guid', async (req, res, next) => {
    try {
        const child = await Children.find(req.profile.guid, req.params.guid);
        if (!child) return res.sendStatus(404);
        return await render(req, res, child);
    } catch (error) { next(error); }
});

for (const [path, editing] of [['/profile/children', false], ['/profile/children/:guid', true]]) {
    router.post(path, async (req, res, next) => {
        try {
            const guid = editing ? req.params.guid : null;
            const section = req.body.section;
            if (section !== undefined && (!editing || !ProfileSections.fields(section, true))) {
                return res.status(422).json({ error: 'Choose an existing child profile section.' });
            }
            if (editing && !await Children.find(req.profile.guid, guid)) return res.sendStatus(404);
            const child = section === undefined
                ? await Children.save(req.profile.guid, guid, req.body)
                : await Children.save(req.profile.guid, guid, req.body, section);
            if (!child) return res.sendStatus(404);
            await AuditLog.record(req.profile, {
                action: editing ? 'child.update' : 'child.create', entityType: 'child', entityGuid: child.guid,
                entityLabel: 'Child profile', details: { self_service: true }
            });
            return section === undefined ? res.redirect('/profile?child_saved=1#my-children') : res.json({ saved: true, values: child.values });
        } catch (error) {
            if (error instanceof Children.ChildInputError) {
                if (req.body.section !== undefined) return res.status(422).json({ error: error.message });
                const child = { ...req.body, guid: editing ? req.params.guid : null,
                    inherit_address: req.body.inherit_address === 'yes',
                    inherit_parental_contact: req.body.inherit_parental_contact === 'yes',
                    inherit_emergency_contact: req.body.inherit_emergency_contact === 'yes',
                    medical_concern: req.body.medical_concern === 'yes' ? true : req.body.medical_concern === 'no' ? false : null,
                    medical_conditions: Array.isArray(req.body.medical_conditions) ? req.body.medical_conditions : [req.body.medical_conditions],
                    interest_sport_guids: Array.isArray(req.body.interest_sport_guids) ? req.body.interest_sport_guids : [req.body.interest_sport_guids] };
                return render(req, res, child, error.message, 422);
            }
            next(error);
        }
    });
}

module.exports = router;
