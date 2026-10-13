const { Router } = require('express');
const authRoutes = require('./auth.routes');
const devicesRoutes = require('./devices.routes');
const pushRoutes = require('./push.routes');

const router = Router();

router.use('/auth', authRoutes);
router.use('/devices', devicesRoutes);
router.use('/push', pushRoutes);

module.exports = router;
