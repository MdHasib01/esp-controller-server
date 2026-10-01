const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const devicesController = require('../controllers/devices.controller');

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(devicesController.list));
router.post('/', asyncHandler(devicesController.create));
router.get('/:id', asyncHandler(devicesController.getOne));
router.patch('/:id', asyncHandler(devicesController.update));

router.post('/:id/wake', asyncHandler(devicesController.wake));
router.post('/:id/led', asyncHandler(devicesController.setLed));
router.post('/:id/checkup/start', asyncHandler(devicesController.startCheckup));
router.post('/:id/checkup/end', asyncHandler(devicesController.endCheckup));

router.get('/:id/events', asyncHandler(devicesController.events));
router.get('/:id/connections', asyncHandler(devicesController.connections));
router.get('/:id/stats', asyncHandler(devicesController.stats));

module.exports = router;
